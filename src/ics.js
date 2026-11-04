'use strict';

// Minimal iCalendar (RFC 5545) export for approved obligations.
// One all-day VEVENT per obligation, on its due date.

function escapeText(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function toICS(obligations, { now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//DeadlineGuard//Obligations//EN',
    'CALSCALE:GREGORIAN',
  ];
  for (const ob of obligations) {
    if (!ob.dueDate) continue;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${ob.id}@deadlineguard`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${ob.dueDate.replace(/-/g, '')}`);
    lines.push(`SUMMARY:${escapeText(`[DeadlineGuard] ${ob.title}`)}`);
    const desc = [
      ob.consequence ? `If missed: ${ob.consequence}` : null,
      ob.amount ? `Amount: ${ob.amount}` : null,
      ob.sourceQuote ? `Source: ${ob.sourceQuote}` : null,
    ].filter(Boolean).join('\n');
    if (desc) lines.push(`DESCRIPTION:${escapeText(desc)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

module.exports = { toICS, escapeText };
