# DeadlineGuard — Clocked Build Challenge submission notes

**Project:** DeadlineGuard
**Builder:** Peter Martinez (solo)
**Deadline:** Nov 10, 2026, 11:59 PM ET
**Repo:** this repository (public, with development history)
**Awards targeted:** Best Overall ($600) · Best Use of Decide/Extract/Fill
($400) · Best Use of Protect/Guard/Inspect ($400) · Best Use of
Verify/Compare/Rerank ($400) — one judged award max per project, so the
entry is built to maximize the single best shot. People's Choice is
deliberately skipped (it requires LinkedIn amplification).

## What the app does

DeadlineGuard reads one household/business document (contract, policy,
invoice — pasted text) and answers three questions: **what must I do, by
when, and what happens if I don't** — then routes every answer through a
human approval queue before anything is "filed." A two-document mode
compares an old policy against its renewal notice, decides which terms
govern, and reranks the combined obligations by deadline urgency.

The signature behavior: the most important date in a contract is usually
a *computed* one — renewal date minus notice period (Feb 15, 2027
renewal with 30 days' notice → act by **Jan 16, 2027**). DeadlineGuard
computes it, shows the arithmetic, and classifies it act-now.

## Which Clocked endpoints it uses, and how the outputs drive the app

Eight of the nine endpoints, all three groups, each one load-bearing:

**Decide / Extract / Fill**
- **Extract** — headline fields (parties, effective/renewal/end dates,
  notice days, monthly/annual amounts, deductible) copied *verbatim*,
  plus the obligation sentences. These values populate the summary card
  and seed every obligation record.
- **Fill** — each obligation sentence becomes a structured record
  (title, due date, amount, consequence) shown in the approval queue.
- **Decide** — classifies each obligation act-now / schedule / ignore
  with a probability, plus a `needs_human_review` judgment. The label
  and confidence are displayed on every queue row and decide what the
  user sees first.

**Protect / Guard / Inspect**
- **Guard** (`injection`) — runs *first*: a pasted document is untrusted
  input, and an injection verdict is displayed on the results card.
- **Protect** (`pii`) — personal-data findings (count + types) are
  surfaced to the user before the document's contents are processed
  into records.
- **Inspect** — risky-clause detection (auto-renewal, termination fee,
  price rise, notice window, auto-pay) runs over the extracted text,
  each flag carrying its source sentence as evidence. (Implemented as
  local detectors fed by the Extract output; the one endpoint not
  called is `script`, which classifies executable scripts — documents
  here are prose, so Guard + Protect carry this group together with the
  inspection layer.)

**Verify / Compare / Rerank**
- **Verify** (`grounding`) — every date and amount in every Fill record
  is checked against the source document. Grounded rows get a
  "✓ grounded" mark; failures are marked **UNVERIFIED** and forced into
  human review by the Decide stage. This is the app's core trust
  mechanism.
- **Compare** — detects field-level conflicts between two documents
  (premium, deductible, fees) with both values shown.
- **Verify + Compare** — the document with the later effective/renewal
  date governs; obligations carrying losing values are marked
  *superseded* in the queue rather than silently dropped.
- **Rerank** — reorders the combined two-document queue by deadline
  urgency.

## Judging-criteria map

- **Meaningful integration:** endpoints aren't a garnish — remove any
  group and a pipeline stage disappears (no extraction → no records; no
  grounding → no trust marks; no decide → no triage; no compare/rerank →
  no two-document mode).
- **Working application:** full loop runs today — paste → analyze →
  approve/edit → export JSON/ICS — served by a dependency-free Node
  server with a real UI.
- **Reproducibility:** zero dependencies; `npm test` runs 21 offline
  tests (adapter units, pipeline end-to-end on the demo documents, live
  client request/error contract, full HTTP loop). The demo needs no
  account and spends no credits (mock adapter, below).
- **Honesty of the demo:** sample documents are real-shaped contracts
  with planted traps (auto-renewal, termination fee, price rise,
  conflicting renewal), and every number the UI shows is traceable to a
  verbatim source sentence displayed next to it.

## The adapter design (read this before judging the mock)

`src/clocked/` contains two interchangeable clients behind one factory:

- `live.js` — the real API client: `POST {base}/{endpoint}`, base URL
  `https://clocked.rezolve.ai/clocked` (the official SDK default),
  `Authorization: Bearer <CLOCKED_API_KEY>`, a fresh `Idempotency-Key`
  per call (so a retry can never double-bill), and the published error
  table mapped onto typed errors (402 → out of credits, 429 → rate
  limited, etc.).
- `mock.js` — a deterministic, dependency-free stand-in implementing
  the same eight methods with the same response envelopes
  (`fields`, `answers`, `verdict`, `results`…), using verbatim-token
  heuristics. It exists so the app, the demo, and the tests run with no
  key and zero credits; setting `CLOCKED_API_KEY` flips every call to
  the live API with no code change.

**Single remaining live-verification step (flagged, not hidden):** the
exact live endpoint paths and answer-envelope field names are the one
part of the contract that can only be confirmed from inside the account
dashboard/docs with a real key. They are isolated in the `PATHS` table
and the response normalizers, so any correction is a one-line change.
This verification — paste the account API key into `.env`, run the two
demo documents against the live API, adjust `PATHS`/normalizers if the
envelopes differ — is the first item on the pre-submission checklist
below and must be done before the entry is filed.

## Pre-submission checklist

- [x] Clocked account created; CLOCKEDHACKATHON code redeemed (20,000 credits)
- [x] App built new for this challenge (Oct 21 – Nov 10 window)
- [x] Full pipeline runs end-to-end on both demo scenarios (tests green)
- [ ] **Live API verification with the real key (the flagged step above)**
- [ ] Demo video recorded (≤3 min: paste broadband contract → notice
      deadline + traps flagged → compare policies → conflict resolved →
      approve queue → ICS export) and public
- [ ] Repo pushed public under pmartinez6400-alt; README verified
- [ ] Entry submitted via the Clocked account before **Nov 10, 2026,
      11:59 PM ET**; repo + demo stay public through Nov 18
- [ ] People's Choice skipped (no LinkedIn post) — by design
- [ ] If won: Wise payout details + W-9 handled by the account holder
      (winners Nov 18; payout ~10 business days after verification)

## What was learned

(Also in the README.) Computed deadlines beat stated ones; "which
document governs" is a verification problem, not a summarization one;
and a visible grounding mark changes how confidently a human approves
machine-read paperwork — which is exactly the behavior a tool like this
should produce.
