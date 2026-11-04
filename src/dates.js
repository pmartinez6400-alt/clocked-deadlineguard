'use strict';

// Verbatim token utilities.
//
// DeadlineGuard's core promise is that it never invents a date or an
// amount. The Clocked Extract endpoint copies values verbatim from the
// source; these helpers let the app (and the offline mock adapter) find,
// normalize, and cross-check those values locally — most importantly for
// the grounding check, which verifies that every date and amount the app
// is about to show the user literally appears in the source document.

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8,
  sept: 8, oct: 9, nov: 10, dec: 11,
};

const MONTH_NAMES = Object.keys(MONTHS).filter((m) => m.length > 3);

function pad(n) {
  return String(n).padStart(2, '0');
}

function toISO(year, monthIndex, day) {
  return `${year}-${pad(monthIndex + 1)}-${pad(day)}`;
}

// One regex with three alternatives: "January 15, 2027", "15 January 2027",
// and numeric "2027-01-15" / "01/15/2027".
const DATE_RE = new RegExp(
  '\\b(?:' +
    '(January|February|March|April|May|June|July|August|September|October|November|December|Jan\\.?|Feb\\.?|Mar\\.?|Apr\\.?|Jun\\.?|Jul\\.?|Aug\\.?|Sep\\.?|Sept\\.?|Oct\\.?|Nov\\.?|Dec\\.?)\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})' +
    '|(\\d{1,2})(?:st|nd|rd|th)?\\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan\\.?|Feb\\.?|Mar\\.?|Apr\\.?|Jun\\.?|Jul\\.?|Aug\\.?|Sep\\.?|Sept\\.?|Oct\\.?|Nov\\.?|Dec\\.?)\\s+(\\d{4})' +
    '|(\\d{4})-(\\d{1,2})-(\\d{1,2})' +
    '|(\\d{1,2})/(\\d{1,2})/(\\d{4})' +
  ')\\b',
  'gi',
);

function monthIndex(name) {
  return MONTHS[name.toLowerCase().replace(/\./g, '')];
}

/** Parse any single date string this module recognizes into ISO yyyy-mm-dd. */
function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return toISO(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return toISO(+m[3], +m[1] - 1, +m[2]);
  m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m && monthIndex(m[1]) !== undefined) return toISO(+m[3], monthIndex(m[1]), +m[2]);
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?\s+(\d{4})$/);
  if (m && monthIndex(m[2]) !== undefined) return toISO(+m[3], monthIndex(m[2]), +m[1]);
  return null;
}

/** Find every date in a text. Returns [{ raw, iso, index }]. */
function findDates(text) {
  const out = [];
  if (!text) return out;
  const re = new RegExp(DATE_RE.source, 'gi');
  let m;
  while ((m = re.exec(String(text))) !== null) {
    let iso = null;
    if (m[1]) iso = toISO(+m[3], monthIndex(m[1]), +m[2]);
    else if (m[5]) iso = toISO(+m[6], monthIndex(m[5]), +m[4]);
    else if (m[7]) iso = toISO(+m[7], +m[8] - 1, +m[9]);
    else if (m[10]) iso = toISO(+m[12], +m[10] - 1, +m[11]);
    if (iso) out.push({ raw: m[0], iso, index: m.index });
  }
  return out;
}

const AMOUNT_RE = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+(?:\.\d{2})?)/g;

/** Find every dollar amount in a text. Returns [{ raw, value, index }]. */
function findAmounts(text) {
  const out = [];
  if (!text) return out;
  const re = new RegExp(AMOUNT_RE.source, 'g');
  let m;
  while ((m = re.exec(String(text))) !== null) {
    out.push({ raw: m[0], value: Number(m[1].replace(/,/g, '')), index: m.index });
  }
  return out;
}

function firstAmount(text) {
  const all = findAmounts(text);
  return all.length ? all[0] : null;
}

/** Split a document into sentences, keeping the text verbatim. Decimal
 * points inside amounts ($79.99) are protected so a price is never cut
 * in half by the splitter. */
function splitSentences(text) {
  if (!text) return [];
  const cleaned = String(text).replace(/\s+/g, ' ').trim();
  const protectedText = cleaned.replace(/(\d)\.(\d)/g, '$1$2');
  const parts = protectedText.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [];
  return parts
    .map((s) => s.replace(//g, '.').trim())
    .filter((s) => s.replace(/[\d.\s]/g, '').length > 0);
}

/** Days from `todayISO` until `targetISO` (negative when past). */
function daysUntil(todayISO, targetISO) {
  const a = Date.parse(`${todayISO}T00:00:00Z`);
  const b = Date.parse(`${targetISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** Add (or subtract) days to an ISO date, returning ISO. */
function addDays(iso, days) {
  const d = new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000);
  return d.toISOString().slice(0, 10);
}

/** Today's date as ISO, in UTC (deterministic enough for a demo app). */
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = {
  MONTH_NAMES,
  parseDate,
  findDates,
  findAmounts,
  firstAmount,
  splitSentences,
  daysUntil,
  addDays,
  todayISO,
};
