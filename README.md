# DeadlineGuard

**Paste a contract, policy or invoice — get back what you must do, by when,
and what happens if you don't. Then approve it before anything is filed.**

DeadlineGuard reads one household or small-business document and turns it
into a human-approved obligations queue. It is built for the **Clocked
Build Challenge** (Rezolve.ai) and uses **eight of the nine Clocked API
endpoints across all three endpoint groups** — not as decoration, but as
the actual pipeline stages.

![status](https://img.shields.io/badge/tests-21%20passing-brightgreen) ![node](https://img.shields.io/badge/node-%3E%3D20-blue) ![dependencies](https://img.shields.io/badge/dependencies-none-lightgrey)

## The problem

The expensive clauses in everyday documents are never the headline price.
They are the auto-renewal you had to cancel 30 days *before* the renewal
date, the early-termination fee, the price that "may increase at renewal,"
the deductible that quietly changed between your old policy and the
renewal notice. People miss them because nobody reads page four.

DeadlineGuard reads page four — and shows its work.

## How it works

### One document

| Stage | Clocked endpoint | What happens |
|---|---|---|
| 1 | **Guard** (`injection`) | The pasted text is scanned for prompt-injection patterns before anything downstream trusts it. A document is untrusted input. |
| 2 | **Protect** (`pii`) | Personal data (emails, phones, account numbers) is found and counted; it is flagged, never silently passed on. |
| 3 | **Extract** | Parties, dates, amounts, notice periods and every obligation sentence are pulled **verbatim**, with the notice deadline computed (renewal date − notice days). |
| 4 | Inspect *(local detectors over the extraction)* | Risky clauses are flagged with their source sentence as evidence: auto-renewal, termination fee, price rise, notice window, auto-pay. |
| 5 | **Fill** | Each obligation sentence becomes a structured record: title, due date, amount, consequence. |
| 6 | **Verify** (`grounding`) | Every date and amount in the record must literally appear in the source document. Anything unverified is marked **UNVERIFIED** — never hidden, never "fixed up." |
| 7 | **Decide** | Each obligation is classified **act-now / schedule / ignore** with a probability, plus a human-review flag. Unverified or risky rows are forced into review. |
| 8 | Approval queue | Everything lands as `pending`. A human approves (with edits) or dismisses. Only approved rows export — to JSON or an `.ics` calendar file. **Nothing files itself.** |

### Two documents (old policy vs renewal notice)

| Stage | Clocked endpoint | What happens |
|---|---|---|
| 9 | **Compare** | Field-level conflicts across the pair: premium $1,240 → $1,410, deductible $1,000 → $1,500. |
| 10 | **Verify** | The document with the later effective/renewal date **governs**; obligations carrying the losing values are marked *superseded*. |
| 11 | **Rerank** | The combined queue is reordered by deadline urgency, so the next real deadline is always on top. |

## Run it

Requires Node.js ≥ 20. No dependencies, nothing to install.

```bash
git clone <this repo>
cd deadlineguard

# Offline demo mode (mock adapter, zero credits, full pipeline):
npm start
# → http://localhost:4317

# Live mode: create an API key on your Clocked account page, then:
CLOCKED_API_KEY=<your key> npm start
```

Run the tests (21 tests, all offline):

```bash
npm test
```

### Try the demo path

1. Click **"Broadband contract (auto-renew trap)"**, then **Analyze
   document**. You get the renewal date (Feb 15, 2027), the *notice
   deadline* it implies (Jan 16, 2027 — 30 days earlier), four flagged
   risk clauses, and four grounded obligations, with the notice
   obligation classified **act-now**.
2. Click **"Compare old vs new policy (demo)"**. The renewal governs;
   the premium and deductible conflicts are shown; the old $1,240
   premium obligation is marked superseded; the queue is reranked with
   the Feb 9, 2027 notice deadline first.
3. Approve a row (edit its date or amount first if you like) and export
   the approved set as JSON or `.ics`.

Sample documents live in [`demo/`](demo/).

## Architecture

```
public/index.html     single-page UI (no build step, no framework)
src/server.js         dependency-free HTTP server + JSON API
src/pipeline.js       the DeadlineGuard pipeline (stages above)
src/clocked/live.js   live Clocked adapter (Bearer auth, Idempotency-Key,
                      published error-status mapping)
src/clocked/mock.js   deterministic offline adapter with the same
                      interface and response envelopes
src/clocked/index.js  adapter factory: live when CLOCKED_API_KEY is set,
                      mock otherwise
src/dates.js          verbatim date/amount tokenizing + normalization
src/store.js          in-memory approval queue
src/ics.js            RFC 5545 export for approved obligations
test/                 node:test suite (mock, pipeline, live-client, server)
```

**Why two adapters?** The challenge budget is the free credit pool, and
the judging environment shouldn't need a key to see the app work. The
mock adapter implements the same eight methods with deterministic
heuristics and the same response shapes, so the entire product — UI,
pipeline, queue, exports, tests — runs offline. Setting
`CLOCKED_API_KEY` switches every call to the real API with no code
change. The live adapter targets the documented contract (base URL
`https://clocked.rezolve.ai/clocked`, Bearer auth, one POST per endpoint,
an `Idempotency-Key` per call so retries can't double-bill); the endpoint
paths are isolated in one `PATHS` table in `src/clocked/live.js`.

**The grounding rule.** DeadlineGuard never invents a date or an amount.
Extraction is verbatim by design, and the Verify step cross-checks every
value in every record against the source text before a human ever sees
it presented as fact. That is the difference between a summary and
something you can act on.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CLOCKED_API_KEY` | *(empty)* | Your Clocked API key. Empty = mock adapter. |
| `CLOCKED_BASE_URL` | `https://clocked.rezolve.ai/clocked` | API base URL. |
| `CLOCKED_ADAPTER` | `auto` | `auto` \| `live` \| `mock`. |
| `PORT` | `4317` | Web app port. |

See [`.env.example`](.env.example).

## What was learned

- The most valuable deadline in a contract is usually a *computed* one:
  renewal date minus notice period. It appears nowhere in the document
  as a date, so extraction alone can't find it — you have to model the
  document's own arithmetic.
- "Which document governs?" is a verification question, not a summary
  question. Comparing values is easy; deciding which set of values is
  *operative*, and visibly superseding the losers, is what makes a
  two-document tool trustworthy.
- A grounding check changes user behavior: people approve faster when
  every number carries a "verified against source" mark — and they
  *should* slow down on the rows that don't.

## License

MIT — see [LICENSE](LICENSE).

Built by Peter Martinez for the Clocked Build Challenge, October–November 2026.
