// api/analyze-application.js
//
// Called by index.html right after an application + its documents are
// saved to Supabase. Reads the uploaded documents (proof of income, credit
// report, government ID) with Claude's vision API, cross-checks them
// against what the client typed into the form, computes a lending
// decision (approved amount or decline + reasons), writes the result back
// onto the application row in Supabase, and returns it to the client so
// the results page can render immediately.
//
// Required environment variable — set this in the Vercel dashboard under
// Project Settings -> Environment Variables -> Production (do NOT commit
// it to this file or paste it into chat):
//   ANTHROPIC_API_KEY
//
// Optional environment variable:
//   CLAUDE_MODEL   (defaults to 'claude-sonnet-5')
//
// If the AI call fails for any reason (missing key, rate limit, unreadable
// document, network issue), this function falls back to a decision based
// purely on the self-reported form data — the client always gets *a*
// result, never a hard error.
//
// Keep the score weights below in sync with calcScore() in index.html.

const SUPABASE_URL = 'https://kngngdqcrqurmcmssjmv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_KlfDOcndtEmcRlBBv7HwDA_i_kUX-Zp';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

// Flat estimate for converting a Gross annual figure to Net — keep in sync
// with GROSS_TO_NET_FACTOR in index.html.
const GROSS_TO_NET_FACTOR = 0.78;

// ─── Loan amount policy by score tier ───────────────────────────────────
// Placeholder defaults — replace with your own tiers/amounts whenever
// you're ready, this is just a reasonable starting point.
const LOAN_TIERS = {
  high:   (requested) => requested,
  medium: (requested) => Math.round((requested * 0.6) / 50) * 50,
  low:    (requested) => Math.max(500, Math.min(1000, Math.round((requested * 0.25) / 50) * 50)),
  poor:   () => 0,
};

function scoreClass(n) { return n >= 70 ? 'high' : n >= 50 ? 'medium' : n >= 30 ? 'low' : 'poor'; }

// Uses the reported Net figure directly when given (matches index.html's
// two-field Net/Gross inputs). Only estimates from Gross as a fallback if
// Net was left blank.
function estimateMonthlyNet(annualNet, annualGross) {
  const net = parseFloat(annualNet) || 0;
  if (net > 0) return net / 12;
  const gross = parseFloat(annualGross) || 0;
  return (gross * GROSS_TO_NET_FACTOR) / 12;
}

// data: { emp_type, monthlyNet, loan_amount, credit_range, job_years, age }
function calcScore(data) {
  const s = { employment: 0, incomeRatio: 0, credit: 0, jobStability: 0, age: 0 };

  s.employment = { fulltime: 30, parttime: 18, selfemployed: 15, retired: 20, other: 8 }[data.emp_type] || 0;

  const ratio = (data.monthlyNet * 3) / (parseFloat(data.loan_amount) || 1);
  s.incomeRatio = ratio >= 2 ? 30 : ratio >= 1.5 ? 24 : ratio >= 1 ? 16 : ratio >= 0.5 ? 8 : 0;

  s.credit = { excellent: 25, verygood: 20, good: 14, fair: 7, poor: 0, unknown: 5 }[data.credit_range] || 0;

  s.jobStability = { '0': 0, '1': 4, '2': 7, '5': 9, '10': 10 }[data.job_years] ?? 5;

  s.age = data.age >= 25 && data.age <= 60 ? 5 : data.age > 60 ? 4 : 2;

  return { total: Math.min(Object.values(s).reduce((a, b) => a + b, 0), 100), breakdown: s };
}

// Client-facing reasons — deliberately does NOT surface "age" as a factor.
// Age is scored internally (small weight, matches calcScore in index.html)
// but calling it out to a declined applicant as a reason risks looking like
// age-based discrimination in a credit decision, which is a real concern
// under Ontario's Human Rights Code. Keep it internal-only.
const REASON_LIBRARY = [
  {
    key: 'employment',
    test: (bd) => bd.employment < 15,
    title: 'Employment type',
    tip: 'Full-time employment strengthens an application the most. If you’re self-employed or part-time, uploading 2 years of Notices of Assessment (NOA) or other proof of steady income can help.',
  },
  {
    key: 'incomeRatio',
    test: (bd) => bd.incomeRatio < 16,
    title: 'Income vs. loan amount',
    tip: 'Your income relative to the requested amount is on the lower side. Try requesting a smaller amount, or add proof of additional income sources.',
  },
  {
    key: 'credit',
    test: (bd) => bd.credit < 14,
    title: 'Credit history',
    tip: 'Paying down existing balances and making on-time payments for 3–6 months typically improves this. A free check at Borrowell or Credit Karma can help you track it before you reapply.',
  },
  {
    key: 'jobStability',
    test: (bd) => bd.jobStability < 7,
    title: 'Time at current job',
    tip: 'Applicants with 1+ years at their current job typically qualify for better terms. This improves automatically the longer you stay at your job.',
  },
];

function buildReasons(breakdown) {
  return REASON_LIBRARY.filter((r) => r.test(breakdown)).map((r) => ({ title: r.title, tip: r.tip }));
}

function guessMediaType(url) {
  const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

async function fetchAsBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch document (${resp.status})`);
  let mediaType = resp.headers.get('content-type') || '';
  if (!mediaType || mediaType === 'application/octet-stream') mediaType = guessMediaType(url);
  const buf = await resp.arrayBuffer();
  return { base64: Buffer.from(buf).toString('base64'), mediaType };
}

function toContentBlock(mediaType, base64) {
  if (mediaType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };
  }
  if (mediaType.startsWith('image/')) {
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
  }
  return null; // unsupported type — skip rather than fail the whole request
}

async function verifyWithClaude(selfReported) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in this Vercel project');

  const docs = [
    ...(selfReported.income_files || []).slice(0, 2).map((f) => ({ ...f, label: 'Proof of Income' })),
    ...(selfReported.credit_files || []).slice(0, 1).map((f) => ({ ...f, label: 'Credit Report' })),
    ...(selfReported.id_files || []).slice(0, 1).map((f) => ({ ...f, label: 'Government ID' })),
  ];
  if (docs.length === 0) throw new Error('No documents were uploaded to analyze');

  const content = [];
  for (const doc of docs) {
    try {
      const { base64, mediaType } = await fetchAsBase64(doc.url);
      const block = toContentBlock(mediaType, base64);
      if (block) {
        content.push({ type: 'text', text: `Document: ${doc.label} (filename: ${doc.name})` });
        content.push(block);
      }
    } catch (e) {
      console.error(`Skipping unreadable document ${doc.name}:`, e.message);
    }
  }
  if (content.length === 0) throw new Error('None of the uploaded documents could be read');

  content.push({
    type: 'text',
    text: `The applicant self-reported: annual net income $${selfReported.annual_income}${selfReported.annual_income_gross ? ` (annual gross income $${selfReported.annual_income_gross})` : ''}, employment type "${selfReported.emp_type}", credit range "${selfReported.credit_range}", name "${selfReported.first_name} ${selfReported.last_name}", date of birth ${selfReported.dob}.

Read the attached document(s) and extract what you can verify. Respond with ONLY a single valid JSON object (no markdown fences, no commentary) matching exactly this shape:
{
  "verified_annual_income": number or null,
  "income_confidence": "high" | "medium" | "low",
  "verified_credit_range": "excellent" | "verygood" | "good" | "fair" | "poor" | null,
  "id_name_match": true | false | null,
  "flags": ["short string describing any mismatch or concern, e.g. paystub income is lower than what was reported"],
  "notes": "one sentence summary"
}

If a pay stub shows a weekly/biweekly/semi-monthly amount, convert it to an annual figure yourself. If a document doesn't let you determine a field, use null for it rather than guessing. If something looks inconsistent with what was self-reported, note it in "flags" instead of silently overriding it.`,
  });

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1024, messages: [{ role: 'user', content }] }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Claude API error ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const json = await resp.json();
  const text = (json.content || []).map((b) => b.text || '').join('').trim();
  const cleaned = text.replace(/^```json\s*|\s*```$/g, '').replace(/^```\s*|\s*```$/g, '');
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Could not parse Claude’s response as JSON: ' + text.slice(0, 200));
  }
}

// Combines self-reported data with AI-verified data. Uses the MORE
// CONSERVATIVE (lower) income figure when both are present, for safety in
// a lending decision — never rounds up based on an unverified claim.
function mergeData(selfReported, verified) {
  const selfMonthlyNet = estimateMonthlyNet(selfReported.annual_income, selfReported.annual_income_gross);
  let monthlyNet = selfMonthlyNet;
  if (verified && verified.verified_annual_income && verified.income_confidence !== 'low') {
    const verifiedMonthlyNet = parseFloat(verified.verified_annual_income) / 12;
    monthlyNet = Math.min(selfMonthlyNet, verifiedMonthlyNet);
  }
  const credit_range = (verified && verified.verified_credit_range) || selfReported.credit_range;
  return {
    emp_type: selfReported.emp_type,
    loan_amount: selfReported.loan_amount,
    job_years: selfReported.job_years,
    age: selfReported.age,
    credit_range,
    monthlyNet,
  };
}

async function updateSupabase(appId, fields) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/applications?id=eq.${encodeURIComponent(appId)}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'content-type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(fields),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Supabase update failed (${resp.status}): ${t.slice(0, 300)}`);
  }
}

function decide(monthlyNetOrMerged, selfReportedForScoring, requestedAmount) {
  const { total, breakdown } = calcScore(selfReportedForScoring);
  const tier = scoreClass(total);
  const approvedAmount = Math.min(requestedAmount, Math.round(LOAN_TIERS[tier](requestedAmount)));
  const decision = approvedAmount > 0 ? 'approved' : 'declined';
  const reasons = buildReasons(breakdown);
  return { total, tier, approvedAmount, decision, reasons };
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
  const { appId, selfReported } = body || {};

  if (!appId || !selfReported) {
    res.status(400).json({ ok: false, error: 'Missing appId or selfReported data' });
    return;
  }

  const requestedAmount = parseFloat(selfReported.loan_amount) || 0;

  try {
    const verified = await verifyWithClaude(selfReported);
    const merged = mergeData(selfReported, verified);
    const { total, tier, approvedAmount, decision, reasons } = decide(null, merged, requestedAmount);

    await updateSupabase(appId, {
      doc_analysis_status: 'complete',
      ai_decision: decision,
      ai_approved_amount: approvedAmount,
      ai_score: total,
      ai_reasons: reasons,
      ai_verified_income: verified.verified_annual_income ?? null,
      ai_verified_credit_range: verified.verified_credit_range ?? null,
      ai_flags: verified.flags || [],
      analyzed_at: new Date().toISOString(),
    });

    res.status(200).json({ ok: true, decision, tier, requestedAmount, approvedAmount, score: total, reasons, verified });
  } catch (err) {
    console.error('analyze-application: falling back to self-reported scoring —', err.message);

    const monthlyNet = estimateMonthlyNet(selfReported.annual_income, selfReported.annual_income_gross);
    const { total, tier, approvedAmount, decision, reasons } = decide(null, { ...selfReported, monthlyNet }, requestedAmount);

    // Persist the fallback decision too (not just the status) so the owner
    // dashboard shows the same result the client saw, even when document
    // verification itself failed/was unavailable.
    try {
      await updateSupabase(appId, {
        doc_analysis_status: 'failed_fallback_self_reported',
        ai_decision: decision,
        ai_approved_amount: approvedAmount,
        ai_score: total,
        ai_reasons: reasons,
        analyzed_at: new Date().toISOString(),
      });
    } catch (e2) {
      console.error('Also failed to record fallback decision in Supabase:', e2.message);
    }

    res.status(200).json({ ok: true, decision, tier, requestedAmount, approvedAmount, score: total, reasons, verified: null, fallback: true });
  }
};
