// The Ripple store: facts + commitments + change sets + append-only ledger.
// Everything is a pure function over an immutable-by-convention World —
// createWorld / changeFacts / propose / decide / execute / advanceTime.
// replay() folds the ledger back into a World and must equal the live one.

import type {
  BudgetStatus,
  ChangeSet,
  Commitment,
  ExecutionOutcome,
  FactEdit,
  FactKey,
  JsonValue,
  LedgerEvent,
  Op,
  Receipt,
  VisitFacts,
  World,
} from './types.js';
import { applyEdits, validateFacts } from './facts.js';
import { desiredCommitments, diff, createOpFor } from './planner.js';
import { POLICIES } from './policies.js';
import { hashParts, canonical } from './ids.js';
import { formatLocal, humanDayTime, parseLocal } from './time.js';

/** How long a change set stays open for decisions (simulated time). */
export const CHANGESET_TTL_MS = 12 * 3_600_000;

const FACT_LABEL: Record<FactKey, string> = {
  arrival: 'arrival',
  departure: 'departure',
  guests: 'guest count',
  budget: 'budget',
};

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function emit(w: World, t: number, e: Omit<LedgerEvent, 'seq' | 't'>): LedgerEvent {
  const ev: LedgerEvent = { seq: w.seq, t, ...e };
  w.seq += 1;
  w.ledger.push(ev);
  return ev;
}

function liveCommitments(w: World): Commitment[] {
  return Object.values(w.commitments).filter((c) => c.state !== 'cancelled');
}

export function commitmentSpend(w: World): number {
  return liveCommitments(w).reduce((s, c) => s + c.cost, 0);
}

export function budgetStatus(w: World): BudgetStatus {
  const committed = commitmentSpend(w);
  const pendingAdds = w.changeSets
    .filter((cs) => cs.status === 'open')
    .flatMap((cs) => cs.ops)
    .filter((o) => o.status === 'proposed' || o.status === 'approved')
    .reduce((s, o) => s + Math.max(0, o.costDelta) + o.fee, 0);
  const projected = committed + w.feesCharged + pendingAdds;
  return {
    budget: w.facts.budget,
    committed,
    fees: w.feesCharged,
    pendingAdds,
    projected,
    feasible: projected <= w.facts.budget,
    overBy: Math.max(0, projected - w.facts.budget),
  };
}

// ---------------------------------------------------------------- plan

/** Create the initial world and run the booking loop for the visit facts.
 *  Every op is auto-approved+executed here — this models "Alexa already
 *  planned the visit with your earlier consent", not silent booking. */
export function createWorld(facts: VisitFacts, now: number): World {
  const v = validateFacts(facts);
  if (!v.ok) throw new Error(`Invalid fixture facts: ${v.errors.join('; ')}`);
  const w: World = {
    facts: clone(facts),
    factsVersion: 1,
    commitments: {},
    changeSets: [],
    ledger: [],
    journal: [{ t: now, type: 'plan', facts: clone(facts) }],
    feesCharged: 0,
    seq: 0,
  };
  emit(w, now, {
    type: 'plan.created',
    factsVersion: 1,
    payload: { facts: facts as unknown as Record<string, JsonValue> },
  });
  for (const d of desiredCommitments(facts)) {
    const c: Commitment = {
      id: d.id,
      service: d.service,
      label: d.label,
      state: 'pending',
      params: clone(d.params),
      cost: d.cost,
      dependsOn: d.dependsOn,
      version: 1,
      createdAt: now,
    };
    w.commitments[c.id] = c;
    emit(w, now, {
      type: 'service.transition',
      commitmentId: c.id,
      factsVersion: 1,
      payload: { from: 'none', to: 'pending', label: c.label },
    });
  }
  advanceTime(w, now);
  emit(w, now, {
    type: 'budget.evaluated',
    factsVersion: 1,
    payload: budgetStatus(w) as unknown as Record<string, JsonValue>,
  });
  return w;
}

// ------------------------------------------------------ service clock

/** Let services advance their own lifecycle to `now` (pending→confirmed→
 *  dispatched→completed). Returns the number of transitions applied. */
export function advanceTime(w: World, now: number): number {
  return advanceTimeInner(w, now, true);
}

function advanceTimeInner(w: World, now: number, journal: boolean): number {
  if (journal) w.journal.push({ t: now, type: 'advance' });
  let moved = 0;
  let again = true;
  while (again) {
    again = false;
    for (const c of Object.values(w.commitments)) {
      if (c.state === 'cancelled' || c.state === 'completed') continue;
      const step = POLICIES[c.service].nextTransition(c, now);
      if (step && step.at <= now) {
        const from = c.state;
        c.state = step.to;
        c.version += 1;
        moved += 1;
        again = true;
        emit(w, now, {
          type: 'service.transition',
          commitmentId: c.id,
          factsVersion: w.factsVersion,
          payload: { from, to: step.to, label: c.label },
        });
      }
    }
  }
  expireStaleChangeSets(w, now);
  return moved;
}

/** A service async event arriving late — e.g. a "completed" ping for a
 *  commitment that has since been cancelled. Recorded truthfully, never
 *  resurrects state. */
export function applyServiceEvent(
  w: World,
  commitmentId: string,
  to: 'completed' | 'confirmed',
  now: number,
): { applied: boolean; stale: boolean } {
  const c = w.commitments[commitmentId];
  if (!c) return { applied: false, stale: false };
  w.journal.push({ t: now, type: 'serviceEvent', commitmentId, to });
  const valid =
    (to === 'confirmed' && c.state === 'pending') ||
    (to === 'completed' && c.state === 'dispatched');
  if (valid) {
    const from = c.state;
    c.state = to;
    c.version += 1;
    emit(w, now, {
      type: 'service.transition',
      commitmentId,
      factsVersion: w.factsVersion,
      payload: { from, to, label: c.label },
    });
    return { applied: true, stale: false };
  }
  emit(w, now, {
    type: 'service.stale_event',
    commitmentId,
    factsVersion: w.factsVersion,
    payload: { ignoredTo: to, actualState: c.state, label: c.label },
  });
  return { applied: false, stale: true };
}

// --------------------------------------------------------- fact changes

export interface ChangeResult {
  ok: boolean;
  errors: string[];
  changeSet?: ChangeSet;
  /** True when the edit produced no param differences — nothing to decide. */
  noOp?: boolean;
}

/** Apply fact edits (after validation), supersede open change sets, diff the
 *  new desired state, and propose a change set. Edits are previewed by the
 *  caller first via previewEdits — this function still re-validates. */
export function changeFacts(w: World, edits: FactEdit[], now: number): ChangeResult {
  const next = applyEdits(w.facts, edits);
  if (next === null) return { ok: false, errors: ['Unknown fact or malformed value in edit.'] };
  const v = validateFacts(next);
  if (!v.ok) return { ok: false, errors: v.errors };

  const changed = edits.map((e) => ({
    key: e.key,
    before: w.facts[e.key] as JsonValue,
    after: next[e.key] as JsonValue,
  }));

  // Idempotence: same edit on identical facts is a no-op.
  if (changed.every((c) => canonical(c.before) === canonical(c.after))) {
    return { ok: true, errors: [], noOp: true };
  }

  w.journal.push({ t: now, type: 'facts', edits: clone(edits) });
  advanceTimeInner(w, now, false);

  w.factsVersion += 1;
  w.facts = next;
  for (const c of changed) {
    emit(w, now, {
      type: 'facts.changed',
      causedBy: c.key,
      factsVersion: w.factsVersion,
      payload: { fact: c.key, before: c.before, after: c.after },
    });
  }

  const cs = propose(w, now, changed.map((c) => `${FACT_LABEL[c.key]} ${fmtVal(c.before)} → ${fmtVal(c.after)}`).join('; '));
  emit(w, now, {
    type: 'budget.evaluated',
    factsVersion: w.factsVersion,
    payload: budgetStatus(w) as unknown as Record<string, JsonValue>,
  });
  return { ok: true, errors: [], changeSet: cs };
}

function fmtVal(v: JsonValue): string {
  if (typeof v === 'string' && parseLocal(v) !== null) return humanDayTime(parseLocal(v)!);
  return String(v);
}

/** Status as it should be shown at `now` — a stored 'open' change set past
 *  its deadline reads as 'expired' without mutating anything. Only
 *  journalled entry points (advanceTime, changeFacts, decide, execute)
 *  actually record expiry events; pure reads never write the ledger, which
 *  is what keeps journal replay deterministic. */
export function effectiveChangeSetStatus(cs: ChangeSet, now: number): ChangeSet['status'] {
  return cs.status === 'open' && now >= cs.expiresAt ? 'expired' : cs.status;
}

export function effectiveOpStatus(cs: ChangeSet, op: Op, now: number): Op['status'] {
  if ((op.status === 'proposed' || op.status === 'approved') && now >= cs.expiresAt) {
    return 'expired';
  }
  return op.status;
}

/** The currently-decidable change set at `now` — pure read, no expiry
 *  mutation. Expired choices are reported as expired but never executed. */
export function openChangeSet(w: World, now: number): ChangeSet | null {
  const cs = w.changeSets[w.changeSets.length - 1];
  return cs && effectiveChangeSetStatus(cs, now) === 'open' ? cs : null;
}

function expireStaleChangeSets(w: World, now: number): void {
  for (const cs of w.changeSets) {
    if (cs.status !== 'open') continue;
    if (now >= cs.expiresAt) {
      cs.status = 'expired';
      for (const o of cs.ops) {
        if (o.status === 'proposed' || o.status === 'approved') {
          o.status = 'expired';
          o.reason = 'Decision window expired.';
          emit(w, now, {
            type: 'op.expired',
            opId: o.id,
            commitmentId: o.commitmentId,
            factsVersion: cs.factsVersion,
            payload: { label: o.label },
          });
        }
      }
      emit(w, now, {
        type: 'changeset.expired',
        factsVersion: cs.factsVersion,
        payload: { changeSetId: cs.id },
      });
    }
  }
}

function propose(w: World, now: number, trigger: string): ChangeSet {
  // Supersede any still-open change set — its ops were computed against facts
  // that no longer exist.
  for (const cs of w.changeSets) {
    if (cs.status !== 'open') continue;
    cs.status = 'superseded';
    for (const o of cs.ops) {
      if (o.status === 'proposed' || o.status === 'approved') {
        o.status = 'superseded';
        o.reason = 'Facts changed before this was decided.';
      }
    }
    emit(w, now, {
      type: 'changeset.superseded',
      factsVersion: w.factsVersion,
      payload: { changeSetId: cs.id },
    });
  }

  const desired = desiredCommitments(w.facts);
  const d = diff(w.commitments, desired, w.factsVersion);
  const ops: Op[] = [];
  for (const raw of d.ops) {
    const op = decorateOp(w, raw, now);
    ops.push(op);
    // Same-day-only conversions (restaurant): the cancel alone would leave
    // desired state unreached, so pair it with an explicit rebook op.
    if (raw.kind === 'update' && op.kind === 'cancel') {
      const dd = desired.find((x) => x.id === raw.commitmentId);
      if (dd) ops.push(decorateOp(w, createOpFor(dd, w.factsVersion), now));
    }
  }

  const cs: ChangeSet = {
    id: hashParts('cs', w.factsVersion, ops.map((o) => o.id).join(',')),
    factsVersion: w.factsVersion,
    ops,
    createdAt: now,
    expiresAt: now + CHANGESET_TTL_MS,
    status: 'open',
    trigger,
  };
  w.changeSets.push(cs);
  emit(w, now, {
    type: 'changeset.proposed',
    factsVersion: w.factsVersion,
    payload: { changeSetId: cs.id, ops: ops.length, trigger },
  });
  return cs;
}

/** Fill in fee/consent/preview fields for a diff op against live state. */
function decorateOp(
  w: World,
  raw: Omit<Op, 'status' | 'requiresConsent' | 'fee' | 'isAlternative'>,
  now: number,
): Op {
  const op: Op = { ...raw, status: 'proposed', isAlternative: false, requiresConsent: false, fee: 0 };
  const live = w.commitments[raw.commitmentId];
  if (raw.kind === 'cancel' && live) {
    op.fee = POLICIES[live.service].cancelFee(live, now);
  }
  if (raw.kind === 'update' && live && live.service === 'restaurant') {
    const decision = POLICIES.restaurant.canUpdate(live, raw.patch, now);
    if (!decision.allowed) {
      // Same-day-only restaurant: the minimal honest path is cancel + rebook.
      // Represented as a cancel op; propose() emits the paired create op
      // because desired state still contains the commitment.
      op.kind = 'cancel';
      op.label = `Cancel ${live.label} (rebook on the new day)`;
      op.after = null;
      op.patch = {};
      op.fee = POLICIES.restaurant.cancelFee(live, now);
      op.costDelta = -live.cost;
      op.irreversibleNote = 'Cancellation is final with this restaurant.';
    }
  }
  if (op.fee > 0) {
    op.requiresConsent = true;
    op.irreversibleNote =
      op.irreversibleNote ??
      `Non-refundable fee: $${op.fee}. Charged once, never netted against savings.`;
  }
  if (raw.kind === 'cancel') op.requiresConsent = true;
  return op;
}

// ------------------------------------------------------------- decisions

export type DecisionResult =
  | { ok: true; op: Op }
  | { ok: false; reason: 'stale' | 'expired' | 'not-found' | 'already-decided'; message: string };

/** Find an op across change sets. */
export function findOp(w: World, opId: string): { cs: ChangeSet; op: Op } | null {
  for (const cs of w.changeSets) {
    const op = cs.ops.find((o) => o.id === opId);
    if (op) return { cs, op };
  }
  return null;
}

/** Consent binds to the normalized op payload + state revision:
 *  the caller must present the payload hash it saw when consenting. */
export function opPayloadHash(op: Op): string {
  return hashParts(
    'payload',
    op.kind,
    op.commitmentId,
    op.before,
    op.after,
    op.patch,
    op.fee,
    op.costDelta,
  );
}

export interface Consent {
  opId: string;
  /** hashParts output the UI computed over the op the human saw. */
  payloadHash: string;
  /** Facts version the human consented against. */
  factsVersion: number;
}

export function approve(w: World, consent: Consent, now: number): DecisionResult {
  w.journal.push({ t: now, type: 'decide', how: 'approve', consent: clone(consent) });
  return decide(w, consent, 'approve', now);
}

export function decline(w: World, consent: Consent, now: number): DecisionResult {
  w.journal.push({ t: now, type: 'decide', how: 'decline', consent: clone(consent) });
  return decide(w, consent, 'decline', now);
}

function decide(w: World, consent: Consent, how: 'approve' | 'decline', now: number): DecisionResult {
  expireStaleChangeSets(w, now);
  const found = findOp(w, consent.opId);
  if (!found) return { ok: false, reason: 'not-found', message: 'No such operation.' };
  const { cs, op } = found;

  if (cs.status === 'expired' || op.status === 'expired') {
    return { ok: false, reason: 'expired', message: 'This choice expired; nothing was executed.' };
  }
  if (cs.status === 'superseded' || op.status === 'superseded' || consent.factsVersion !== w.factsVersion) {
    return { ok: false, reason: 'stale', message: 'Facts changed — this approval is no longer valid.' };
  }
  if (op.status !== 'proposed') {
    return { ok: false, reason: 'already-decided', message: `Already ${op.status}.` };
  }
  if (opPayloadHash(op) !== consent.payloadHash) {
    return { ok: false, reason: 'stale', message: 'Operation changed since you reviewed it.' };
  }

  op.status = how === 'approve' ? 'approved' : 'declined';
  emit(w, now, {
    type: how === 'approve' ? 'op.approved' : 'op.declined',
    opId: op.id,
    commitmentId: op.commitmentId,
    factsVersion: w.factsVersion,
    payload: { label: op.label, kind: op.kind },
  });
  refreshChangeSetStatus(w, cs, now);
  return { ok: true, op };
}

function refreshChangeSetStatus(w: World, cs: ChangeSet, now: number): void {
  if (cs.status !== 'open') return;
  const undecided = cs.ops.some((o) => o.status === 'proposed' || o.status === 'approved');
  if (!undecided) cs.status = 'decided';
  void now;
  void w;
}

// ------------------------------------------------------------- execution

/** Execute every approved op in the open change set, in order. Each op is
 *  checked against live policy at execution time — a dispatched delivery
 *  cannot be cancelled or rescheduled, and the rejection is recorded
 *  truthfully with the original commitment left untouched. */
export function executeApproved(w: World, now: number): ExecutionOutcome[] {
  w.journal.push({ t: now, type: 'execute' });
  expireStaleChangeSets(w, now); // journalled entry point — expiry is recorded
  const cs = w.changeSets[w.changeSets.length - 1];
  if (!cs || cs.status !== 'open') return [];
  const outcomes: ExecutionOutcome[] = [];
  for (const op of cs.ops) {
    if (op.status !== 'approved') continue;
    outcomes.push(executeOp(w, cs, op, now));
  }
  refreshChangeSetStatus(w, cs, now);
  return outcomes;
}

function executeOp(w: World, cs: ChangeSet, op: Op, now: number): ExecutionOutcome {
  const live = w.commitments[op.commitmentId];
  const policy = live ? POLICIES[live.service] : POLICIES[op.service];

  let allowed = true;
  let reason: string | undefined;
  if (live) {
    const decision =
      op.kind === 'cancel'
        ? policy.canCancel(live, now)
        : op.kind === 'create'
          ? { allowed: true } // create over an existing id means "rebook" — handled below
          : policy.canUpdate(live, op.patch, now);
    allowed = decision.allowed;
    reason = decision.reason;
  }
  if (allowed && op.kind === 'create' && live && live.state !== 'cancelled') {
    allowed = false;
    reason = 'Commitment already exists.';
  }

  if (!allowed) {
    op.status = 'rejected';
    op.reason = reason ?? 'Rejected by service policy.';
    emit(w, now, {
      type: 'op.rejected',
      opId: op.id,
      commitmentId: op.commitmentId,
      factsVersion: w.factsVersion,
      payload: { label: op.label, reason: op.reason },
    });
    maybeOfferAlternative(w, cs, op, live, now);
    return { opId: op.id, status: 'rejected', reason: op.reason };
  }

  if (op.kind === 'cancel') {
    if (live) {
      const from = live.state;
      live.state = 'cancelled';
      live.version += 1;
      emit(w, now, {
        type: 'service.transition',
        commitmentId: live.id,
        factsVersion: w.factsVersion,
        payload: { from, to: 'cancelled', label: live.label },
      });
    }
  } else if (op.kind === 'create' || op.kind === 'alternative') {
    const c: Commitment = {
      id: op.commitmentId,
      service: op.service,
      label: op.label.replace(/^Book |^Add /, ''),
      state: 'pending',
      params: clone(op.after ?? {}),
      cost: Math.max(0, (op.after?.['cost'] as number) ?? op.costDelta),
      dependsOn: op.dependsOn ?? live?.dependsOn ?? [],
      version: 1,
      createdAt: now,
    };
    w.commitments[c.id] = c;
    emit(w, now, {
      type: 'service.transition',
      commitmentId: c.id,
      factsVersion: w.factsVersion,
      payload: { from: 'none', to: 'pending', label: c.label },
    });
  } else if (op.kind === 'update' && live) {
    for (const [k, v] of Object.entries(op.patch)) {
      if (v === null) delete live.params[k];
      else live.params[k] = v;
    }
    live.version += 1;
  }

  if (op.fee > 0) {
    w.feesCharged += op.fee;
    emit(w, now, {
      type: 'fee.charged',
      opId: op.id,
      commitmentId: op.commitmentId,
      factsVersion: w.factsVersion,
      payload: { amount: op.fee, label: op.label, sunk: true },
    });
  }
  op.status = 'executed';
  emit(w, now, {
    type: 'op.executed',
    opId: op.id,
    commitmentId: op.commitmentId,
    factsVersion: w.factsVersion,
    payload: { label: op.label, kind: op.kind, before: op.before ?? {}, after: op.after ?? {} },
  });
  const outcome: ExecutionOutcome = { opId: op.id, status: 'executed' };
  if (op.fee > 0) outcome.feeCharged = op.fee;
  return outcome;
}

/** When a policy rejection leaves the desired state unreachable, propose a
 *  feasible alternative as a separate, separately-approved op. */
function maybeOfferAlternative(
  w: World,
  cs: ChangeSet,
  op: Op,
  live: Commitment | undefined,
  now: number,
): void {
  if (!live) return;
  if (op.kind !== 'update' && op.kind !== 'cancel') return;
  if (live.service !== 'grocery') return;

  // Dispatched grocery: original order stands; offer a new top-up delivery
  // matching the new arrival window and party size, charged separately.
  const arrival = parseLocal(w.facts.arrival)!;
  const altAfter: Record<string, JsonValue> = {
    windowStart: formatLocal(arrival - 60 * 60_000),
    windowEnd: formatLocal(arrival + 60 * 60_000),
    items: 4 + w.facts.guests * 2,
    guests: w.facts.guests,
    note: 'Top-up delivery: the earlier order could not be changed after dispatch.',
    cost: 60,
  };
  const altId = `grocery:topup-${hashParts('arr', w.facts.arrival)}`;
  const alt: Op = {
    id: hashParts('op', w.factsVersion, altId, 'alternative', altAfter),
    kind: 'alternative',
    service: 'grocery',
    commitmentId: altId,
    isAlternative: true,
    label: 'Add Saturday top-up delivery',
    before: null,
    after: altAfter,
    patch: {},
    fee: 0,
    costDelta: 60,
    requiresConsent: true,
    irreversibleNote:
      'New charge on top of the dispatched order. The original delivery still arrives Friday and is billed.',
    dependsOn: ['arrival', 'guests'],
    status: 'proposed',
  };
  if (cs.ops.every((o) => o.id !== alt.id)) {
    cs.ops.push(alt);
    emit(w, now, {
      type: 'changeset.proposed',
      factsVersion: w.factsVersion,
      causedBy: 'arrival',
      payload: { changeSetId: cs.id, alternative: alt.id, becauseOf: op.id },
    });
  }
}

// --------------------------------------------------------------- declines

/** Record-kept decline semantics: while facts stay at `factsVersion`, an op
 *  signature that was declined is suppressed from fresh proposals and the
 *  existing commitment is annotated kept-by-choice. */
export function declinedSignatures(w: World): Set<string> {
  const sigs = new Set<string>();
  for (const cs of w.changeSets) {
    if (cs.factsVersion !== w.factsVersion) continue;
    for (const o of cs.ops) {
      if (o.status === 'declined') sigs.add(opSignature(o));
    }
  }
  return sigs;
}

export function opSignature(o: Pick<Op, 'kind' | 'commitmentId' | 'after'>): string {
  return hashParts('sig', o.kind, o.commitmentId, o.after);
}

/** Re-plan against current facts, suppressing signatures already declined at
 *  this facts version. Used when a change set expires or after a rejection
 *  to surface the remaining honest path. */
export function repropose(w: World, now: number, trigger = 're-plan'): ChangeSet {
  w.journal.push({ t: now, type: 'repropose', trigger });
  const cs = propose(w, now, trigger);
  const sigs = declinedSignatures(w);
  for (const o of cs.ops) {
    if (sigs.has(opSignature(o))) {
      o.status = 'declined';
      o.reason = 'You declined this change; it stays as booked.';
      const live = w.commitments[o.commitmentId];
      emit(w, now, {
        type: 'kept_by_choice',
        opId: o.id,
        commitmentId: o.commitmentId,
        factsVersion: w.factsVersion,
        payload: { label: live?.label ?? o.label },
      });
    }
  }
  return cs;
}

// ---------------------------------------------------------------- ledger

/** Re-derive a world by replaying its journal of external inputs through
 *  the same deterministic functions. Equality with the live world (facts,
 *  commitments, fees — and the full ledger) is a tested invariant. */
export function replay(journal: World['journal']): World {
  const first = journal[0];
  if (!first || first.type !== 'plan') {
    throw new Error('Journal must start with a plan entry.');
  }
  // createWorld pushes its own plan journal entry; we replay the remaining
  // inputs on top without re-journalling them, then restore the journal.
  const w = createWorld(first.facts, first.t);
  // createWorld pushes plan + an initial advance; keep only the canonical
  // plan entry so the replayed journal matches the input exactly.
  w.journal.length = 1;
  w.journal[0] = first;
  for (const entry of journal.slice(1)) {
    applyJournal(w, entry);
  }
  return w;
}

function applyJournal(w: World, entry: World['journal'][number]): void {
  const mark = w.journal.length;
  switch (entry.type) {
    case 'facts': {
      changeFacts(w, clone(entry.edits), entry.t);
      break;
    }
    case 'decide': {
      decide(w, clone(entry.consent), entry.how, entry.t);
      break;
    }
    case 'advance': {
      advanceTimeInner(w, entry.t, false);
      break;
    }
    case 'serviceEvent': {
      applyServiceEvent(w, entry.commitmentId, entry.to, entry.t);
      break;
    }
    case 'repropose': {
      repropose(w, entry.t, entry.trigger ?? 're-plan');
      break;
    }
    case 'execute': {
      executeApproved(w, entry.t);
      break;
    }
    case 'plan':
      break;
  }
  // Replace whatever the inner call journalled with the canonical input
  // entry, so the replayed journal is byte-identical to the original.
  w.journal.length = mark;
  w.journal.push(entry);
}

/** Consent recomputed for a currently-proposed op (what the UI builds when
 *  the human clicks approve/decline). */
export function consentFor(w: World, op: Op): Consent {
  return {
    opId: op.id,
    payloadHash: opPayloadHash(op),
    factsVersion: w.factsVersion,
  };
}

/** World summary used by tests and the status tool. */
export function worldSummary(w: World): {
  facts: VisitFacts;
  liveCommitments: { id: string; state: string; params: Record<string, JsonValue>; cost: number }[];
  feesCharged: number;
  openOps: number;
  budget: BudgetStatus;
} {
  const cs = w.changeSets[w.changeSets.length - 1];
  return {
    facts: clone(w.facts),
    liveCommitments: liveCommitments(w).map((c) => ({
      id: c.id,
      state: c.state,
      params: clone(c.params),
      cost: c.cost,
    })),
    feesCharged: w.feesCharged,
    openOps: cs && cs.status === 'open' ? cs.ops.filter((o) => o.status === 'proposed').length : 0,
    budget: budgetStatus(w),
  };
}

export function receiptsForFact(w: World, fact: FactKey): Receipt {
  const ops = w.changeSets
    .flatMap((cs) => cs.ops)
    .filter((o) => {
      // ops caused by this fact = created in a changeset whose trigger
      // mentions it, or whose commitment depends on it
      const c = w.commitments[o.commitmentId];
      return c?.dependsOn.includes(fact) ?? true;
    });
  const events = w.ledger.filter((e) => e.causedBy === fact);
  return { fact, factsVersion: w.factsVersion, ops, events };
}

/** Causal recall: "what changed because of the flight/arrival?" returns the
 *  commitments whose params were touched by a facts.changed on `fact`. */
export function recallByFact(w: World, fact: FactKey): {
  fact: FactKey;
  changedCommitments: { id: string; label: string; whatChanged: Record<string, JsonValue> }[];
  unaffected: { id: string; label: string }[];
} {
  const changedIds = new Set<string>();
  const patches: Record<string, Record<string, JsonValue>> = {};
  for (const cs of w.changeSets) {
    for (const o of cs.ops) {
      const dep = (w.commitments[o.commitmentId]?.dependsOn ?? []) as FactKey[];
      const caused = dep.includes(fact) || o.isAlternative;
      if (!caused) continue;
      if (o.status === 'executed' || o.status === 'approved') {
        changedIds.add(o.commitmentId);
        patches[o.commitmentId] = { ...(patches[o.commitmentId] ?? {}), ...o.patch };
      }
    }
  }
  const changedCommitments = [...changedIds].map((id) => ({
    id,
    label: w.commitments[id]?.label ?? id,
    whatChanged: patches[id] ?? {},
  }));
  const unaffected = Object.values(w.commitments)
    .filter((c) => c.state !== 'cancelled' && !changedIds.has(c.id))
    .map((c) => ({ id: c.id, label: c.label }));
  return { fact, changedCommitments, unaffected };
}

// --------------------------------------------------------- persistence

export const WORLD_SCHEMA_VERSION = 1;

export function serializeWorld(w: World): string {
  return JSON.stringify({ v: WORLD_SCHEMA_VERSION, world: w });
}

/** Parse + validate a serialized world. Returns null on any malformed or
 *  mismatched-version input — persistence must never crash the app. */
export function deserializeWorld(raw: string | null): World | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { v?: number; world?: World };
    if (parsed.v !== WORLD_SCHEMA_VERSION || !parsed.world) return null;
    const w = parsed.world;
    if (
      typeof w.facts !== 'object' ||
      typeof w.factsVersion !== 'number' ||
      typeof w.commitments !== 'object' ||
      !Array.isArray(w.changeSets) ||
      !Array.isArray(w.ledger) ||
      !Array.isArray(w.journal) ||
      typeof w.feesCharged !== 'number' ||
      typeof w.seq !== 'number'
    ) {
      return null;
    }
    if (validateFacts(w.facts).ok !== true) return null;
    return w;
  } catch {
    return null;
  }
}

/** Deep-equal the observable state of two worlds (replay equality check). */
export function stateEquals(a: World, b: World): boolean {
  const strip = (w: World) => ({
    facts: w.facts,
    factsVersion: w.factsVersion,
    feesCharged: w.feesCharged,
    commitments: Object.fromEntries(
      Object.entries(w.commitments).map(([k, c]) => [
        k,
        { state: c.state, params: c.params, cost: c.cost, service: c.service },
      ]),
    ),
  });
  return canonical(strip(a) as unknown as JsonValue) === canonical(strip(b) as unknown as JsonValue);
}
