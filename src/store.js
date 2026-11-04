'use strict';

// In-memory approval queue.
//
// DeadlineGuard's rule: nothing is "filed" until a human approves it.
// Analyzed obligations land here as `pending`; a person approves (with
// optional edits), dismisses, or leaves them. Only `approved` rows are
// exported. State is intentionally process-local for the demo build —
// restart the server and the queue clears.

class ObligationStore {
  constructor() {
    this.items = new Map();
    this.seq = 0;
  }

  add(obligation) {
    this.seq += 1;
    const id = `ob-${this.seq}`;
    const item = { id, status: 'pending', ...obligation };
    this.items.set(id, item);
    return item;
  }

  get(id) {
    return this.items.get(id) || null;
  }

  list() {
    return [...this.items.values()];
  }

  approved() {
    return this.list().filter((i) => i.status === 'approved');
  }

  approve(id, edits = {}) {
    const item = this.get(id);
    if (!item) return null;
    for (const key of ['title', 'dueDate', 'amount', 'action', 'consequence']) {
      if (edits[key] !== undefined) item[key] = edits[key];
    }
    item.status = 'approved';
    item.decidedAt = new Date().toISOString();
    return item;
  }

  dismiss(id) {
    const item = this.get(id);
    if (!item) return null;
    item.status = 'dismissed';
    item.decidedAt = new Date().toISOString();
    return item;
  }

  clear() {
    this.items.clear();
    this.seq = 0;
  }
}

module.exports = { ObligationStore };
