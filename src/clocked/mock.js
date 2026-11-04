'use strict';

// Mock adapter for the Clocked API.
//
// Implements the same eight methods as the live client with deterministic,
// dependency-free heuristics, so DeadlineGuard runs end-to-end — and its
// test suite passes — with no API key and zero credits spent. Responses
// deliberately mirror the documented live envelopes (result.fields,
// result.answers, result.verdict, result.results, ...) so swapping the
// live adapter in changes nothing upstream.
//
// The mock is honest about what it is: a rules-based stand-in. Dates and
// amounts are copied verbatim from the source text, never invented —
// which is also the real API's contract for Extract.

const { findDates, findAmounts, firstAmount, splitSentences } = require('../dates');

const OBLIGATION_CUES = [
  /\bshall\b/i, /\bmust\b/i, /\bis required to\b/i, /\bagrees to\b/i,
  /\bautomatically renews\b/i, /\brenews automatically\b/i, /\bautomatic renewal\b/i,
  /\bprovide written notice\b/i, /\bmay terminate\b/i,
  /\bis responsible for\b/i, /\bwill be charged\b/i,
  /\bpayable\b/i, /\bis due\b/i, /\bmust return\b/i,
];

const PII_PATTERNS = [
  { type: 'email', re: /[\w.+-]+@[\w-]+\.[\w.]+/g },
  { type: 'phone', re: /\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4}\b/g },
  { type: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: 'account_number', re: /\b(?:account|acct)\s*(?:no\.?|number|#)?\s*[:#]?\s*(\d{6,})/gi },
];

const INJECTION_PATTERNS = [
  /ignore (all )?(previous|prior|above) instructions/i,
  /you are now [A-Z]/,
  /disregard your (system|instructions|rules)/i,
  /reveal (your|the) system prompt/i,
  /override (your|the) (safety|restrictions|rules)/i,
  /act as (an? )?(unrestricted|jailbroken)/i,
];

function sentenceWith(text, keywordRe) {
  return splitSentences(text).find((s) => keywordRe.test(s)) || null;
}

function firstDateRaw(sentence) {
  if (!sentence) return null;
  const dates = findDates(sentence);
  return dates.length ? dates[0].raw : null;
}

// First date found in a sentence that matches the keyword AND actually
// contains a date — section headings like "Renewal." match the keyword
// but carry no date, and must not shadow the real sentence.
function firstDateRawMatching(text, keywordRe) {
  for (const s of splitSentences(text)) {
    if (keywordRe.test(s)) {
      const raw = firstDateRaw(s);
      if (raw) return raw;
    }
  }
  return null;
}

// First amount found in any sentence matching the keyword.
function firstAmountRawMatching(text, keywordRe) {
  for (const s of splitSentences(text)) {
    if (keywordRe.test(s)) {
      const a = firstAmount(s);
      if (a) return a.raw;
    }
  }
  return null;
}

function labeledValue(text, labels) {
  for (const label of labels) {
    const re = new RegExp(`(?:^|\\n)\\s*${label}\\s*:\\s*([^\\n.;]+)`, 'i');
    const m = String(text).match(re);
    if (m) return m[1].trim();
  }
  return null;
}

class MockClockedClient {
  constructor() {
    this.mode = 'mock';
  }

  // --- Extract: values copied verbatim from the source -------------------
  async extract({ text = '', fields = {} } = {}) {
    const out = {};
    for (const key of Object.keys(fields)) {
      out[key] = this.extractField(text, key, fields[key]);
    }
    return { fields: out };
  }

  extractField(text, key, _spec) {
    const lower = key.toLowerCase();
    if (lower === 'obligations') {
      return splitSentences(text)
        .filter((s) => OBLIGATION_CUES.some((re) => re.test(s)))
        .slice(0, 12);
    }
    if (lower === 'provider') {
      return labeledValue(text, ['Service Provider', 'Provider', 'Insurer', 'Company'])
        || (String(text).match(/provided by ([A-Z][\w&.,' ]+?)(?:\.|,|\n)/) || [])[1]?.trim()
        || null;
    }
    if (lower === 'customer') {
      return labeledValue(text, ['Customer', 'Policyholder', 'Subscriber', 'Client', 'Account holder'])
        || null;
    }
    if (lower.includes('renewal') && lower.includes('date')) {
      return firstDateRawMatching(text, /renew/i);
    }
    if (lower.includes('effective') || lower.includes('start')) {
      return firstDateRawMatching(text, /effective|commences|begins|starts/i);
    }
    if (lower.includes('end') || lower.includes('expir')) {
      return firstDateRawMatching(text, /expire|ends|end of the (current )?term|termination date/i);
    }
    if (lower.includes('notice')) {
      const s = sentenceWith(text, /notice/i);
      const m = s && s.match(/(\d+)\s*days?/i);
      return m ? m[1] : null;
    }
    if (lower.includes('monthly')) {
      return firstAmountRawMatching(text, /month/i);
    }
    if (lower.includes('annual') || lower.includes('premium') || lower.includes('yearly')) {
      return firstAmountRawMatching(text, /annual|premium|per year|yearly/i);
    }
    if (lower.includes('deductible')) {
      return firstAmountRawMatching(text, /deductible/i);
    }
    if (lower.includes('total') || lower.includes('amount')) {
      const a = firstAmount(text);
      return a ? a.raw : null;
    }
    if (lower.includes('term')) {
      const m = String(text).match(/(\d+)\s*-?\s*months?/i);
      return m ? m[1] : null;
    }
    return null;
  }

  // --- Decide: classify with a probability for every option ---------------
  // The pipeline encodes the decision context in `state` as plain text,
  // including machine-readable cue lines (DUE_IN_DAYS=..., RISK=...,
  // UNVERIFIED=1) alongside the human-readable obligation. The live model
  // reads the whole state semantically; the mock scores the cues.
  async decide({ state = '', questions = {} } = {}) {
    const answers = {};
    const dueMatch = String(state).match(/DUE_IN_DAYS=(-?\d+)/);
    const due = dueMatch ? Number(dueMatch[1]) : null;
    const hasRisk = /RISK=(?!none\b)[a-z-]+/i.test(state);
    const unverified = /UNVERIFIED=1/.test(state);

    for (const name of Object.keys(questions)) {
      if (name === 'action') {
        let probs;
        if (due !== null && due < 0) probs = { 'act-now': 0.97, schedule: 0.02, ignore: 0.01 };
        else if ((due !== null && due <= 30) || hasRisk) probs = { 'act-now': 0.88, schedule: 0.09, ignore: 0.03 };
        else if (due !== null && due <= 120) probs = { 'act-now': 0.12, schedule: 0.8, ignore: 0.08 };
        else if (due === null && /\$[\d]/.test(state)) probs = { 'act-now': 0.1, schedule: 0.62, ignore: 0.28 };
        else probs = { 'act-now': 0.05, schedule: 0.25, ignore: 0.7 };
        if (unverified) probs = { 'act-now': 0.55, schedule: 0.35, ignore: 0.1 };
        const value = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
        answers[name] = { value, probability: probs[value], probabilities: probs };
      } else if (name === 'needs_human_review') {
        answers[name] = unverified || hasRisk;
      } else {
        answers[name] = null;
      }
    }
    return { answers };
  }

  // --- Fill: a complete record in one read --------------------------------
  async fill({ text = '', fields = {} } = {}) {
    const out = {};
    const dates = findDates(text);
    const amount = firstAmount(text);
    for (const key of Object.keys(fields)) {
      const lower = key.toLowerCase();
      if (lower.includes('date')) out[key] = dates.length ? dates[0].raw : null;
      else if (lower.includes('amount') || lower.includes('fee') || lower.includes('price')) out[key] = amount ? amount.raw : null;
      else if (lower.includes('consequence')) {
        const m = String(text).match(/(?:otherwise|if not|failure to|in which case|will result in)\s+(.+)$/i);
        out[key] = m ? m[1].trim() : null;
      } else if (lower.includes('title') || lower.includes('action')) {
        out[key] = String(text).replace(/\s+/g, ' ').trim().split(/\s+/).slice(0, 9).join(' ');
      } else out[key] = null;
    }
    return { fields: out };
  }

  // --- Protect (PII): find personal data, return a transformed copy -------
  async pii({ text = '', anonymize = 'replace' } = {}) {
    const findings = [];
    let anonymized = String(text);
    for (const { type, re } of PII_PATTERNS) {
      const r = new RegExp(re.source, re.flags);
      let m;
      while ((m = r.exec(String(text))) !== null) {
        findings.push({ type, value: m[0], index: m.index });
      }
      if (anonymize === 'replace') {
        anonymized = anonymized.replace(new RegExp(re.source, re.flags), `[${type.toUpperCase()}]`);
      }
    }
    findings.sort((a, b) => a.index - b.index);
    return { findings, anonymized_text: anonymized };
  }

  // --- Guard (injection): is this text trying to hijack the reader? -------
  async injection({ text = '' } = {}) {
    const matches = INJECTION_PATTERNS.filter((re) => re.test(String(text))).map((re) => re.source);
    return {
      injection: matches.length > 0,
      verdict: matches.length > 0 ? 'injection_detected' : 'clean',
      matches,
    };
  }

  // --- Verify (grounding): every claim in the answer must be in the source -
  async grounding({ documents = [], answer = '' } = {}) {
    const sourceText = documents.map((d) => (typeof d === 'string' ? d : d.text || '')).join('\n');
    const sourceDates = new Set(findDates(sourceText).map((d) => d.iso));
    const sourceAmounts = new Set(findAmounts(sourceText).map((a) => a.value));
    const claims = [];
    for (const d of findDates(answer)) {
      claims.push({ kind: 'date', token: d.raw, iso: d.iso, found: sourceDates.has(d.iso) });
    }
    for (const a of findAmounts(answer)) {
      claims.push({ kind: 'amount', token: a.raw, value: a.value, found: sourceAmounts.has(a.value) });
    }
    const ungrounded = claims.filter((c) => !c.found);
    return {
      verdict: ungrounded.length === 0 ? 'grounded' : 'ungrounded',
      answers_question: true,
      claims,
      ungrounded,
    };
  }

  // --- Compare: duplicates and conflicts across documents -----------------
  async compare({ documents = [] } = {}) {
    const texts = documents.map((d) => (typeof d === 'string' ? d : d.text || ''));
    const probe = (t, re) => {
      const raw = firstAmountRawMatching(t, re);
      if (!raw) return null;
      const a = firstAmount(raw);
      return a ? a.value : null;
    };
    const fieldProbes = [
      ['monthly_amount', /month/i],
      ['annual_premium', /annual|premium|per year/i],
      ['deductible', /deductible/i],
      ['termination_fee', /termination fee/i],
    ];
    const conflicts = [];
    for (const [field, re] of fieldProbes) {
      const values = texts.map((t, i) => ({ docIndex: i, value: probe(t, re) })).filter((v) => v.value !== null);
      const distinct = new Set(values.map((v) => v.value));
      if (values.length > 1 && distinct.size > 1) conflicts.push({ field, values });
    }
    const normalized = texts.map((t) => t.replace(/\s+/g, ' ').trim());
    const duplicates = normalized.length > 1 && new Set(normalized).size < normalized.length
      ? [{ docIndexes: normalized.map((_, i) => i) }]
      : [];
    return {
      verdict: conflicts.length ? 'conflicts' : duplicates.length ? 'duplicates' : 'distinct',
      conflicts,
      duplicates,
    };
  }

  // --- Rerank: order passages by how well they answer the query -----------
  async rerank({ query = '', documents = [], top_n: topN } = {}) {
    const todayMatch = String(query).match(/TODAY=(\d{4}-\d{2}-\d{2})/);
    const today = todayMatch ? todayMatch[1] : null;
    const results = documents.map((doc, index) => {
      const text = typeof doc === 'string' ? doc : doc.text || '';
      const id = (typeof doc === 'object' && doc.id) || `doc-${index}`;
      let score = 0.2;
      const dates = findDates(text);
      if (today && dates.length) {
        const soonest = Math.min(...dates.map((d) => {
          const diff = (Date.parse(d.iso) - Date.parse(today)) / 86400000;
          return Number.isFinite(diff) ? diff : 9999;
        }));
        if (soonest < 0) score = 0.98;
        else if (soonest <= 30) score = 0.9;
        else if (soonest <= 90) score = 0.7;
        else score = 0.45;
      }
      if (/renew|penalt|fee|notice|cancel/i.test(text)) score = Math.min(1, score + 0.05);
      return {
        index,
        id,
        action: score >= 0.4 ? 'use' : 'skip',
        ...(score < 0.4 ? { reason: 'unrelated' } : {}),
        relevance_score: Math.round(score * 100) / 100,
        document_score: Math.round(score * 100) / 100,
      };
    });
    results.sort((a, b) => b.relevance_score - a.relevance_score);
    return { results: topN ? results.slice(0, topN) : results };
  }
}

module.exports = { MockClockedClient };
