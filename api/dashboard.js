// api/dashboard.js
//
// Single endpoint for everything the owner dashboard needs, gated behind a
// real server-side session. Added 2026-07-07 after discovering the previous
// setup was NOT actually secure — see CLAUDE.md "Critical fix" note.
//
// Previously the browser called Supabase directly with the anon/publishable
// key for dashboard reads/writes, and the "owner login" was just a
// client-side JS string compare (OWNER_PASS) — trivially visible in page
// source and enforced nothing, because the applications table itself had
// pre-existing wide-open RLS policies (allow_select/allow_update/allow_insert
// granted to `public` with a `true` check) letting ANYONE read or write the
// full table with just the public key, regardless of the login screen.
//
// Fix: the applications table's RLS policies were locked down (see the SQL
// in CLAUDE.md) so anon/authenticated can only INSERT a brand-new pending
// application — no SELECT, no UPDATE. All dashboard reads/writes now go
// through this file instead, authenticated by a signed session cookie and
// using the service_role key (which bypasses RLS) server-side only.
//
// POST body shapes (all POST, dispatched by `action`):
//   { action: 'login', password, reviewerName? }   -> sets a signed session cookie
//   { action: 'logout' }                            -> clears the cookie
//   { action: 'data' }                              -> returns all applications + audit history (session required)
//   { action: 'update', appId, status, reason? }    -> approve/decline/reset + audit log entry (session required)
//
// Required env vars (Vercel -> Project Settings -> Environment Variables):
//   OWNER_DASHBOARD_PASSWORD   - plain password, compared server-side only, never sent to the client
//   SESSION_SECRET             - random string used to sign session cookies (any long random value)
//   SUPABASE_SERVICE_ROLE_KEY  - bypasses RLS; NEVER expose this client-side or log it
//
// One shared login for now (per the owner, 2026-07-07) — reviewerName is an
// optional free-text label ("Vith", "Owner", etc.) captured at login time so
// the audit trail already has a human-readable actor without needing real
// per-person accounts yet. When multiple real logins are wanted later, only
// this file's login check needs to change (e.g. a small lookup table of
// username -> password) — the session/cookie/audit-log plumbing doesn't.

const crypto = require('crypto');

const SUPABASE_URL = 'https://kngngdqcrqurmcmssjmv.supabase.co';
const COOKIE_NAME = 'ql_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(input) {
  input = input.replace(/-/g, '+').replace(/_/g, '/');
  while (input.length % 4) input += '=';
  return Buffer.from(input, 'base64').toString('utf8');
}

function signSession(reviewer) {
  const payload = JSON.stringify({ reviewer, exp: Date.now() + SESSION_TTL_MS });
  const encoded = base64url(payload);
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(encoded).digest('hex');
  return `${encoded}.${sig}`;
}

function verifySession(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE_NAME + '='));
  if (!match) return null;
  const token = match.slice(COOKIE_NAME.length + 1);
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(encoded).digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(encoded));
  } catch (e) {
    return null;
  }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload; // { reviewer, exp }
}

function setCookie(res, token, maxAgeSeconds) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`
  );
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
}

async function sbFetch(path, options = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return resp;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { action } = body || {};

  // ---- login ----
  if (action === 'login') {
    const { password, reviewerName } = body;
    if (!process.env.OWNER_DASHBOARD_PASSWORD) {
      res.status(500).json({ ok: false, error: 'Dashboard password is not configured on the server' });
      return;
    }
    const supplied = Buffer.from(String(password || ''));
    const expected = Buffer.from(process.env.OWNER_DASHBOARD_PASSWORD);
    const match = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    if (!match) {
      res.status(401).json({ ok: false, error: 'Incorrect password' });
      return;
    }
    const reviewer = (reviewerName || '').trim().slice(0, 60) || 'Owner';
    const token = signSession(reviewer);
    setCookie(res, token, SESSION_TTL_MS / 1000);
    res.status(200).json({ ok: true, reviewer });
    return;
  }

  // ---- logout ----
  if (action === 'logout') {
    clearCookie(res);
    res.status(200).json({ ok: true });
    return;
  }

  // Everything below requires a valid session.
  const session = verifySession(req);
  if (!session) {
    res.status(401).json({ ok: false, error: 'Not logged in' });
    return;
  }

  // ---- data ----
  if (action === 'data') {
    try {
      const [appsResp, auditResp] = await Promise.all([
        sbFetch('applications?select=*&order=submitted_at.desc'),
        sbFetch('audit_log?select=*&order=created_at.desc'),
      ]);
      if (!appsResp.ok) throw new Error(`Failed to load applications (${appsResp.status})`);
      const applications = await appsResp.json();
      const auditLog = auditResp.ok ? await auditResp.json() : [];

      const historyByApp = {};
      for (const entry of auditLog) {
        (historyByApp[entry.application_id] = historyByApp[entry.application_id] || []).push(entry);
      }
      for (const app of applications) {
        app.audit_history = historyByApp[app.id] || [];
      }

      res.status(200).json({ ok: true, applications, reviewer: session.reviewer });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
    return;
  }

  // ---- update (approve / decline / reset) ----
  if (action === 'update') {
    const { appId, status, reason } = body;
    if (!appId || !status) {
      res.status(400).json({ ok: false, error: 'Missing appId or status' });
      return;
    }
    if (!['pending', 'approved', 'declined'].includes(status)) {
      res.status(400).json({ ok: false, error: 'Invalid status' });
      return;
    }
    try {
      const patchResp = await sbFetch(`applications?id=eq.${encodeURIComponent(appId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status }),
      });
      if (!patchResp.ok) {
        const t = await patchResp.text();
        throw new Error(`Failed to update application (${patchResp.status}): ${t.slice(0, 200)}`);
      }
      const auditResp = await sbFetch('audit_log', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          application_id: appId,
          actor: session.reviewer,
          action: status,
          reason: reason || null,
          created_at: new Date().toISOString(),
        }),
      });
      if (!auditResp.ok) {
        const t = await auditResp.text();
        console.error('Failed to write audit log entry:', t.slice(0, 300));
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
    return;
  }

  res.status(400).json({ ok: false, error: 'Unknown action' });
};
