'use strict';

// DeadlineGuard pipeline — where the Clocked endpoints do the work.
//
// Single document:
//   1. Extract  — headline fields + obligation sentences, verbatim.
//   2. Guard    — injection scan on the pasted text before anything
//                 downstream trusts it (Protect group).
//   3. Protect  — PII scan: personal data in the document is counted and
//                 flagged, never silently shipped onward.
//   4. Inspect  — risky-clause detectors (auto-renew, penalty, price
//                 rise, notice window) over the source text.
//   5. Fill     — each obligation sentence becomes a structured record.
//   6. Verify   — grounding check: every date/amount in the record must
//                 literally appear in the source. Failures are flagged,
//                 never hidden.
//   7. Decide   — act-now / schedule / ignore with a probability, plus a
//                 human-review flag. Low-confidence or unverified rows
//                 are forced into the review queue.
//   8. Queue    — everything lands as `pending`. A human approves.
//
// Two documents:
//   9. Compare  — field-level conflicts (price, deductible, fees).
//  10. Verify   — the document with the later effective/renewal date
//                 governs; the older document's conflicting obligations
//                 are marked superseded.
//  11. Rerank   — the combined queue is ordered by deadline urgency.

const {
  parseDate, findDates, firstAmount, splitSentences, daysUntil, addDays, todayISO,
} = require('./dates');
const { ObligationStore } = require('./store');

const EXTRACT_FIELDS = {
  provider: 'Name of the company or provider issuing the document',
  customer: 'Name of the customer, subscriber or policyholder',
  effective_date: 'The date the agreement takes effect, as written',
  renewal_date: 'The date the agreement renews, as written',
  end_date: 'The date the current term ends or expires, as written',
  notice_days: 'How many days of notice are required to cancel or stop renewal',
  monthly_amount: 'The recurring monthly amount, as written',
  annual_amount: 'The annual amount or premium, as written',
  deductible_amount: 'The deductible amount, as written',
  obligations: { description: 'Sentences that require someone to do something', list: true, max_items: 12 },
};

const RISK_DETECTORS = [
  { id: 'auto-renew', label: 'Auto-renewal trap', re: /automatically renews|auto-?renew|renews automatically|automatic renewal/i },
  { id: 'termination-fee', label: 'Termination / penalty fee', re: /termination fee|early termination|penalt/i },
  { id: 'price-rise', label: 'Price may rise', re: /may increase|increase (?:the )?(?:monthly )?(?:price|fee|rate)|price increase|rates? may change/i },
  { id: 'notice-window', label: 'Notice deadline applies', re: /written notice|notice (?:of|to) cancel|days(?:')? (?:prior )?notice/i },
  { id: 'auto-pay', label: 'Automatic payment', re: /automatically (?:charge|debit|bill)|auto-?pay/i },
];

function detectRisks(text) {
  const risks = [];
  for (const sentence of splitSentences(text)) {
    for (const det of RISK_DETECTORS) {
      if (det.re.test(sentence) && !risks.some((r) => r.id === det.id)) {
        risks.push({ id: det.id, label: det.label, evidence: sentence });
      }
    }
  }
  return risks;
}

function normalizeActionAnswer(answer) {
  if (answer == null) return { label: 'schedule', confidence: null };
  if (typeof answer === 'string') return { label: answer, confidence: null };
  if (typeof answer === 'boolean') return { label: answer ? 'act-now' : 'ignore', confidence: null };
  const label = answer.value ?? answer.answer ?? answer.label ?? answer.choice ?? 'schedule';
  const confidence = answer.probability ?? answer.confidence ?? null;
  return { label: String(label), confidence };
}

function titleFromSentence(sentence) {
  const s = sentence.replace(/\s+/g, ' ').trim();
  if (/written notice/i.test(s) && /renew/i.test(s)) return 'Give notice to stop auto-renewal';
  if (/written notice/i.test(s)) return 'Give written notice';
  if (/\bpay\b|\bfee\b|\bbill/i.test(s)) {
    const amt = firstAmount(s);
    return amt ? `Payment obligation (${amt.raw})` : 'Payment obligation';
  }
  if (/cancel/i.test(s)) return 'Cancellation right / action';
  if (/renew/i.test(s)) return 'Renewal term takes effect';
  if (/deductible/i.test(s)) return 'Deductible applies';
  const words = s.split(/\s+/).slice(0, 8).join(' ');
  return words.length < s.length ? `${words}…` : words;
}

class DeadlineGuard {
  constructor(client, { store = new ObligationStore(), today = null } = {}) {
    this.client = client;
    this.store = store;
    this.today = today || todayISO();
  }

  async analyzeDocument(text, { title = 'Document', storeResults = true } = {}) {
    if (!text || !String(text).trim()) throw new Error('Document text is empty');

    // Protect group first: never let a hostile or PII-laden paste flow
    // downstream unexamined.
    const injection = await this.client.injection({ text, source: 'user', evidence: true });
    const pii = await this.client.pii({ text, entities: ['person', 'email', 'phone', 'username'], threshold: 0.5, anonymize: 'replace' });

    const extraction = await this.client.extract({ text, fields: EXTRACT_FIELDS });
    const fields = extraction.fields || {};
    const renewalISO = parseDate(fields.renewal_date);
    const noticeDays = fields.notice_days ? Number(fields.notice_days) : null;
    const noticeDeadlineISO = renewalISO && noticeDays ? addDays(renewalISO, -noticeDays) : null;

    const risks = detectRisks(text);
    const riskIds = new Set(risks.map((r) => r.id));
    const sentences = Array.isArray(fields.obligations) ? fields.obligations : [];

    const obligations = [];
    for (const sentence of sentences) {
      const filled = await this.client.fill({
        text: sentence,
        fields: {
          record_title: 'Short title for this obligation',
          due_date: 'The date this must be done by, as written',
          amount: 'Any amount involved, as written',
          consequence: 'What happens if this is not done',
        },
      });
      const rec = filled.fields || {};

      // Due date: a notice sentence is governed by the computed notice
      // deadline (renewal − notice days) — the date inside such a
      // sentence is the renewal date itself, not when the owner must
      // act. Otherwise an explicit date in the sentence wins.
      let dueISO = null;
      let dueBasis = null;
      if (/written notice/i.test(sentence) && noticeDeadlineISO) {
        dueISO = noticeDeadlineISO;
        dueBasis = `renewal ${renewalISO} minus ${noticeDays} days notice`;
      } else {
        dueISO = parseDate(rec.due_date) || (findDates(sentence)[0] || {}).iso || null;
        dueBasis = dueISO ? 'stated in document' : null;
      }
      const amountRaw = rec.amount || (firstAmount(sentence) || {}).raw || null;

      // Verify (grounding): the record's date and amount must literally
      // appear in the source text before we show them as facts.
      const claimText = [titleFromSentence(sentence), rec.due_date || '', amountRaw || ''].join(' ').trim();
      const grounding = await this.client.grounding({
        documents: [{ id: 'source', text }],
        question: 'What must be done, by when, and for how much?',
        answer: claimText,
        evidence: 'all',
      });
      const verified = grounding.verdict === 'grounded';

      const obRisks = RISK_DETECTORS.filter((d) => d.re.test(sentence)).map((d) => d.id);
      const dueInDays = dueISO ? daysUntil(this.today, dueISO) : null;

      const state = [
        `Obligation: ${sentence}`,
        `Document: ${title}`,
        dueInDays !== null ? `DUE_IN_DAYS=${dueInDays}` : 'DUE_IN_DAYS=unknown',
        obRisks.length ? `RISK=${obRisks.join(',')}` : 'RISK=none',
        verified ? 'VERIFIED=1' : 'UNVERIFIED=1',
        'Classify this obligation for the document owner.',
      ].join('\n');
      const decision = await this.client.decide({
        state,
        questions: {
          action: {
            type: 'choice',
            options: ['act-now', 'schedule', 'ignore'],
            instructions: 'act-now when a deadline is within 30 days, already past, unverified, or a financial trap applies; schedule when it is a real future obligation; ignore when nothing is required.',
          },
          needs_human_review: {
            type: 'noul',
            instructions: 'True when the extraction is unverified, confidence is low, or money is at risk.',
          },
        },
      });
      const action = normalizeActionAnswer((decision.answers || {}).action);
      const needsReview = Boolean((decision.answers || {}).needs_human_review) || !verified;

      const obligation = {
        title: titleFromSentence(sentence),
        action: action.label,
        confidence: action.confidence,
        reason: [
          dueInDays !== null ? `due in ${dueInDays} day(s) (${dueISO})` : 'no fixed due date found',
          obRisks.length ? `risk: ${obRisks.join(', ')}` : null,
          verified ? 'dates/amounts verified against source' : 'UNVERIFIED — check against source',
        ].filter(Boolean).join('; '),
        needsHumanReview: needsReview,
        dueDate: dueISO,
        dueBasis,
        amount: amountRaw,
        consequence: rec.consequence || null,
        sourceQuote: sentence,
        risks: obRisks,
        grounding: { verdict: grounding.verdict, ungrounded: grounding.ungrounded || [] },
        documentTitle: title,
      };
      obligations.push(storeResults ? this.store.add(obligation) : obligation);
    }

    return {
      title,
      adapter: this.client.mode,
      today: this.today,
      fields: {
        provider: fields.provider ?? null,
        customer: fields.customer ?? null,
        effectiveDate: parseDate(fields.effective_date),
        renewalDate: renewalISO,
        endDate: parseDate(fields.end_date),
        noticeDays,
        noticeDeadline: noticeDeadlineISO,
        monthlyAmount: fields.monthly_amount ?? null,
        annualAmount: fields.annual_amount ?? null,
        deductibleAmount: fields.deductible_amount ?? null,
      },
      risks,
      safety: {
        injection: { detected: Boolean(injection.injection), verdict: injection.verdict },
        piiFindings: (pii.findings || []).length,
        piiTypes: [...new Set((pii.findings || []).map((f) => f.type))],
      },
      obligations,
    };
  }

  async compareDocuments(textA, textB, { titleA = 'Older document', titleB = 'Newer document' } = {}) {
    const a = await this.analyzeDocument(textA, { title: titleA, storeResults: false });
    const b = await this.analyzeDocument(textB, { title: titleB, storeResults: false });

    const comparison = await this.client.compare({ documents: [textA, textB] });
    const conflicts = comparison.conflicts || [];

    // Which document governs? The one with the later renewal/effective
    // date; if neither can be dated, the second (presented as newer).
    const dateOf = (r) => r.fields.renewalDate || r.fields.effectiveDate || '';
    const governingIndex = dateOf(b) >= dateOf(a) ? 1 : 0;
    const governingTitle = governingIndex === 1 ? titleB : titleA;

    const conflictFields = new Set(conflicts.map((c) => c.field));
    // An obligation from the losing document is superseded only when it
    // carries one of the conflicting (losing) values — a price change
    // does not cancel unrelated duties in the old document.
    const losingValues = new Set();
    for (const c of conflicts) {
      for (const v of c.values) {
        if (v.docIndex !== governingIndex && v.value !== null) losingValues.add(v.value);
      }
    }
    const tag = (obs, idx) => obs.map((ob) => {
      const amt = ob.amount ? Number(String(ob.amount).replace(/[^0-9.]/g, '')) : null;
      const superseded = idx !== governingIndex && amt !== null && losingValues.has(amt);
      return { ...ob, superseded, governing: idx === governingIndex };
    });
    const combined = [...tag(a.obligations, 0), ...tag(b.obligations, 1)];
    combined.forEach((ob, i) => { ob._rid = `ob-x${i}`; });

    // Rerank the combined queue by deadline urgency.
    const reranked = await this.client.rerank({
      query: `Which obligations must be acted on first, soonest deadline first? TODAY=${this.today}`,
      documents: combined.map((ob) => ({
        id: ob._rid,
        text: `${ob.title}. Due ${ob.dueDate || 'no fixed date'}. ${ob.sourceQuote}`,
      })),
    });
    const order = new Map((reranked.results || []).map((r, rank) => [r.id, rank]));
    combined.sort((x, y) => (order.get(x._rid) ?? 99) - (order.get(y._rid) ?? 99));
    combined.forEach((ob) => { delete ob._rid; });

    const stored = combined.map((ob) => {
      const { superseded, governing, ...rest } = ob;
      return this.store.add({ ...rest, superseded, governing });
    });

    return {
      adapter: this.client.mode,
      today: this.today,
      verdict: comparison.verdict,
      conflicts: conflicts.map((c) => ({
        field: c.field,
        values: c.values,
        governingDocument: governingTitle,
      })),
      conflictFields: [...conflictFields],
      governingDocument: governingTitle,
      documents: [
        { title: titleA, fields: a.fields, risks: a.risks },
        { title: titleB, fields: b.fields, risks: b.risks },
      ],
      obligations: stored,
    };
  }
}

module.exports = { DeadlineGuard, detectRisks, normalizeActionAnswer, EXTRACT_FIELDS, RISK_DETECTORS };
