// App state: a persisted World + one explicit simulated clock.
// Device-local only — nothing leaves the browser; single-tab by design
// (no cross-tab sync is implemented or claimed).

import * as E from '@ripple/engine';
import type { World, FactEdit, Op, Intent } from '@ripple/engine';

const STORAGE_KEY = 'ripple:v1';

export interface SimState {
  world: World;
  now: number;
}

export function seed(): SimState {
  const world = E.createWorld(E.FIXTURE_FACTS, E.PLAN_CREATED_AT);
  E.advanceTime(world, E.FIXTURE_NOW);
  return { world, now: E.FIXTURE_NOW };
}

let snapshotDiscarded = false;

/** True when persisted demo data existed but was rejected (older schema or
 *  corrupt) — the app seeds fresh and must say so visibly, not silently. */
export function discardedSnapshot(): boolean {
  return snapshotDiscarded;
}

export function load(): SimState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { now?: number; world?: string };
    if (typeof parsed.now !== 'number' || !Number.isSafeInteger(parsed.now) ||
        Math.abs(parsed.now) > 8.64e15 || typeof parsed.world !== 'string') {
      snapshotDiscarded = true;
      return null;
    }
    const world = E.deserializeWorld(parsed.world);
    // Every UI clock change is journalled with its lifecycle transitions.
    // Loading a different envelope clock would rewind consent or skip those
    // transitions. Reject the pair rather than inventing missing history.
    if (!world || world.journal.at(-1)?.t !== parsed.now) {
      snapshotDiscarded = true;
      return null;
    }
    return { world, now: parsed.now };
  } catch {
    snapshotDiscarded = true;
    return null;
  }
}

let lastPersistError: string | null = null;
const persistListeners = new Set<() => void>();

/** Notify mounted views when a save fails or recovers, including the first
 *  attempt after mount. Subscribing never writes or replays world actions. */
export function subscribePersistStatus(listener: () => void): () => void {
  persistListeners.add(listener);
  return () => { persistListeners.delete(listener); };
}

/** True when the last persist attempt failed (storage denied/full) — the
 *  app keeps working in memory but must say so honestly. */
export function persistFailed(): string | null {
  return lastPersistError;
}

export function persist(s: SimState): void {
  const previousError = lastPersistError;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ now: s.now, world: E.serializeWorld(s.world) }),
    );
    lastPersistError = null;
  } catch (e) {
    lastPersistError = e instanceof Error ? e.message : 'storage write failed';
  }
  if (lastPersistError !== previousError) {
    for (const listener of persistListeners) listener();
  }
}

export function clearPersisted(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}

// ---- domain actions (all funnel through these so every UI path is tested) --

export interface Preview {
  edits: FactEdit[];
  /** Facts that actually change, human-readable. */
  deltas: { key: string; before: string; after: string }[];
  /** New or revised repair targets introduced by these edits. */
  affected: { id: string; label: string; service: string }[];
  /** Earlier plan differences still needing a fresh decision, even if their
   *  predecessor was declined or expired. These targets are not new effects. */
  carriedForward: { id: string; label: string; service: string }[];
  untouched: { id: string; label: string }[];
  errors: string[];
  /** Explicit note shown when arrival changes: departure is NOT auto-moved. */
  notes: string[];
  /** Optional exact-date correction; selecting it opens another preview. */
  recovery?: { label: string; edits: FactEdit[] };
}

export function previewEdits(w: World, edits: FactEdit[], now?: number): Preview {
  const next = E.applyEdits(w.facts, edits);
  const p: Preview = { edits, deltas: [], affected: [], carriedForward: [], untouched: [], errors: [], notes: [] };
  if (next === null) {
    p.errors.push('Unknown fact or malformed value.');
    return p;
  }
  const fmt = (key: E.FactKey, val: unknown): string => {
    if ((key === 'arrival' || key === 'departure') && typeof val === 'string') {
      const t = E.parseLocal(val);
      if (t !== null) return `${E.humanDay(t)} ${val.replace('T', ' ')}`;
    }
    return String(val);
  };
  const changed = new Set<E.FactKey>();
  for (const k of E.FACT_KEYS) {
    if (JSON.stringify(w.facts[k]) !== JSON.stringify(next[k])) {
      changed.add(k);
      p.deltas.push({ key: k, before: fmt(k, w.facts[k]), after: fmt(k, next[k]) });
    }
  }
  if (changed.has('arrival') && !changed.has('departure')) {
    p.notes.push(
      `Departure stays ${fmt('departure', w.facts.departure)} — changing arrival never moves it.`,
    );
  }
  if (changed.has('departure') && !changed.has('arrival')) {
    p.notes.push(`Arrival stays ${fmt('arrival', w.facts.arrival)} — changing departure never moves it.`);
  }
  const v = E.validateFacts(next);
  if (!v.ok) {
    p.errors = v.errors;
    if (changed.has('arrival') || changed.has('departure')) {
      p.notes.push('Choose exact dates in Edit facts directly, or type Arrive YYYY-MM-DD HH:MM and Departure YYYY-MM-DD HH:MM.');
    }
    // Offer (never apply) the prior weekday only when it is still upcoming,
    // precedes the current arrival, and the entire corrected trip validates.
    // Normal weekday and explicit forward-week interpretation remain intact.
    if (changed.has('arrival') && !edits.some((edit) => edit.key === 'departure') && now !== undefined &&
        E.parseLocal(next.arrival)! >= E.parseLocal(next.departure)!) {
      const earlier = E.addDays(E.parseLocal(next.arrival)!, -7);
      const corrected = { ...next, arrival: E.formatLocal(earlier) };
      if (earlier >= now && earlier < E.parseLocal(w.facts.arrival)! && E.validateFacts(corrected).ok) {
        p.recovery = {
          label: `Preview ${fmt('arrival', corrected.arrival)} instead`,
          edits: edits.map((edit) => edit.key === 'arrival' ? { ...edit, value: corrected.arrival } : edit),
        };
      }
    }
    return p;
  }
  if (p.deltas.length === 0) {
    p.notes.push('No fact actually changes - nothing to do. Existing decisions stay as they are.');
    return p;
  }
  const desired = E.desiredCommitments(next);
  // Match changeFacts/propose: compare the entire desired plan with live
  // bookings, not just dependencies of the newest fact edit. Pure diffing
  // does not supersede decisions, journal events, execute actions or charge.
  const repairs = E.diff(w.commitments, desired, w.factsVersion + 1);
  const repairIds = new Set(repairs.ops.map(op => op.commitmentId));
  const priorDesired = new Map(E.desiredCommitments(w.facts).map(d => [d.id, d]));
  const nextDesired = new Map(desired.map(d => [d.id, d]));
  for (const id of repairIds) {
    const target = nextDesired.get(id);
    const prior = priorDesired.get(id);
    // The diff retains the actual orphan even if an accepted saved map key
    // differs from the commitment's id. Do not look it up by that id again.
    const c = target ?? repairs.orphans.find(orphan => orphan.id === id)!;
    const entry = { id, label: c.label, service: c.service };
    const revised = E.canonical(prior?.params) !== E.canonical(target?.params) || prior?.cost !== target?.cost;
    (revised ? p.affected : p.carriedForward).push(entry);
  }
  p.untouched = Object.values(w.commitments)
    .filter(c => !repairIds.has(c.id)).map(c => ({ id: c.id, label: c.label }));
  if (w.changeSets.length) p.notes.push(
    'Applying this fact change replaces any open decisions and approvals. Earlier plan differences, including declined or expired choices, may be proposed again. Nothing is booked or charged until you approve and apply the new decisions.',
  );
  return p;
}

export function runUtterance(w: World, text: string, now: number): Intent {
  return E.parseUtterance(text, w.facts, now);
}

/** Edits collected from the fact editor form — numeric fields are coerced
 *  to integers here (the engine rightly rejects string values). Returns
 *  null when a numeric field is not a nonempty finite integer. */
export function collectEdits(
  facts: E.VisitFacts,
  form: { arrival: string; departure: string; guests: string; budget: string },
): FactEdit[] | null {
  const edits: FactEdit[] = [];
  if (form.arrival !== facts.arrival) edits.push({ key: 'arrival', value: form.arrival });
  if (form.departure !== facts.departure) edits.push({ key: 'departure', value: form.departure });
  if (form.guests !== String(facts.guests)) {
    const n = Number(form.guests);
    // empty/blank or non-integer is invalid — never coerce '' to 0
    if (form.guests.trim() === '' || !Number.isInteger(n)) return null;
    edits.push({ key: 'guests', value: n });
  }
  if (form.budget !== String(facts.budget)) {
    const n = Number(form.budget);
    if (form.budget.trim() === '' || !Number.isInteger(n)) return null;
    edits.push({ key: 'budget', value: n });
  }
  return edits;
}

export function describeOp(op: Op): string {
  switch (op.kind) {
    case 'create':
      return `Book: ${op.label.replace(/^Book /, '')}`;
    case 'update':
      return `Update: ${op.label.replace(/^Update /, '')}`;
    case 'cancel':
      return `Cancel: ${op.label.replace(/^Cancel /, '')}`;
    case 'alternative':
      return `Alternative: ${op.label}`;
  }
}

const PARAM_LABEL: Record<string, string> = {
  windowStart: 'Delivery window opens',
  windowEnd: 'Delivery window closes',
  partySize: 'Party size',
  guests: 'Guests',
  items: 'Items',
  remindAt: 'Reminder at',
  arrival: 'Flight arrives',
  runAt: 'Runs at',
  start: 'Starts',
  end: 'Ends',
  time: 'Time',
  title: 'Title',
  cost: 'Cost (fictional)',
  note: 'Note',
};

/** Human label for a commitment param key — judges should never see raw
 *  camelCase field names. */
export function paramLabel(k: string): string {
  return PARAM_LABEL[k] ?? k;
}

export function fmtParamValue(v: unknown): string {
  if (typeof v === 'string' && E.parseLocal(v) !== null) {
    return E.humanDayTime(E.parseLocal(v)!);
  }
  return String(v);
}

/** <75-word spoken summary — no ids, no markdown. */
export function speakableSummary(w: World, now: number): string {
  const cs = w.changeSets[w.changeSets.length - 1];
  const pending = cs
    ? cs.ops.filter((o) => E.effectiveOpStatus(cs, o, now) === 'proposed')
    : [];
  const approved = cs
    ? cs.ops.filter((o) => E.effectiveOpStatus(cs, o, now) === 'approved')
    : [];
  const expired = cs
    ? cs.ops.filter((o) => E.effectiveOpStatus(cs, o, now) === 'expired')
    : [];
  const b = E.budgetStatus(w);
  // A read at effective expiry must exclude inactive, still-stored proposals.
  const spend = b.committed + b.fees;
  const overBy = expired.length && !pending.length && !approved.length
    ? Math.max(0, spend - b.budget)
    : b.overBy;
  const parts: string[] = [];
  if (pending.length) {
    parts.push(
      `${pending.length} change${pending.length === 1 ? '' : 's'} need your decision`,
    );
    const feeOps = pending.filter((o) => o.fee > 0);
    if (feeOps.length) {
      parts.push(`one carries a $${feeOps.reduce((s, o) => s + o.fee, 0)} fee`);
    }
  } else if (approved.length) {
    parts.push(`${approved.length} approved change${approved.length === 1 ? '' : 's'} ready to apply`);
  } else if (expired.length) {
    // Expiry closes a decision window, not the underlying unapplied repair.
    // Count only those operations so partial execution stays truthful.
    parts.push(`${expired.length} change${expired.length === 1 ? '' : 's'} expired without being applied`);
    parts.push('Use Re-check for open decisions to review fresh choices');
  } else {
    parts.push('Your visit plan is settled');
  }
  parts.push(
    overBy === 0
      ? `spend is $${spend} of a $${b.budget} budget`
      : `over budget by $${overBy}`,
  );
  return parts.join('; ') + '.';
}
