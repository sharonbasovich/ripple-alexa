// Desired-state derivation and minimal diff.
//
// desiredCommitments(facts) is pure: the same facts always produce the same
// desired set. diff() compares desired params against live commitments and
// emits the smallest op set — unchanged commitments produce no op, an update
// op carries only the params that actually changed.

import type {
  Commitment,
  FactKey,
  JsonValue,
  Op,
  OpKind,
  ServiceId,
  VisitFacts,
} from './types.js';
import { parseLocal, formatLocal, dayStart } from './time.js';
import { hashParts, canonical } from './ids.js';

export interface DesiredCommitment {
  id: string;
  service: ServiceId;
  label: string;
  params: Record<string, JsonValue>;
  cost: number;
  dependsOn: FactKey[];
}

// ---- fictional pricing (synthetic, labelled as such in UI) ----
export const PRICE = {
  groceryBase: 40,
  groceryPerGuest: 18,
  restaurantPerSeat: 40,
  topUpDelivery: 60,
} as const;

const iso = (t: number) => formatLocal(t);

export function desiredCommitments(f: VisitFacts): DesiredCommitment[] {
  const arrival = parseLocal(f.arrival)!;
  const departure = parseLocal(f.departure)!;

  return [
    {
      id: 'calendar:visit',
      service: 'calendar',
      label: 'Family visit',
      params: { start: iso(arrival), end: iso(departure), guests: f.guests },
      cost: 0,
      dependsOn: ['arrival', 'departure', 'guests'],
    },
    {
      id: 'grocery:arrival-delivery',
      service: 'grocery',
      label: 'Arrival-day grocery delivery',
      params: {
        windowStart: iso(arrival - 60 * 60_000),
        windowEnd: iso(arrival + 60 * 60_000),
        items: 6 + f.guests * 4,
        guests: f.guests,
      },
      cost: PRICE.groceryBase + PRICE.groceryPerGuest * f.guests,
      dependsOn: ['arrival', 'guests'],
    },
    {
      id: 'restaurant:arrival-dinner',
      service: 'restaurant',
      label: 'Arrival-day dinner reservation',
      params: { time: iso(arrival + 90 * 60_000), partySize: f.guests + 1 },
      cost: PRICE.restaurantPerSeat * (f.guests + 1),
      dependsOn: ['arrival', 'guests'],
    },
    {
      id: 'routines:welcome',
      service: 'routines',
      label: 'Guest welcome routine',
      params: { runAt: iso(arrival - 30 * 60_000), guests: f.guests },
      cost: 0,
      dependsOn: ['arrival', 'guests'],
    },
    {
      id: 'routines:coffee',
      service: 'routines',
      label: 'Morning coffee routine',
      params: {
        // 07:55 the morning after arrival day
        runAt: iso(dayStart(arrival) + 86_400_000 + (7 * 60 + 55) * 60_000),
        cups: f.guests + 1,
      },
      cost: 0,
      dependsOn: ['arrival', 'guests'],
    },
    {
      id: 'pickup:airport',
      service: 'pickup',
      label: 'Airport pickup reminder',
      params: { remindAt: iso(arrival - 70 * 60_000), arrival: iso(arrival) },
      cost: 0,
      dependsOn: ['arrival'],
    },
    {
      id: 'routines:farewell',
      service: 'routines',
      label: 'Departure-day lock-up routine',
      params: { runAt: iso(departure - 60 * 60_000) },
      cost: 0,
      dependsOn: ['departure'],
    },
  ];
}

function paramsEqual(
  a: Record<string, JsonValue>,
  b: Record<string, JsonValue>,
): boolean {
  return canonical(a) === canonical(b);
}

export function paramPatch(
  before: Record<string, JsonValue>,
  after: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const patch: Record<string, JsonValue> = {};
  for (const k of Object.keys(after)) {
    const v = after[k]!;
    if (canonical(before[k]) !== canonical(v)) patch[k] = v;
  }
  for (const k of Object.keys(before)) {
    if (!(k in after)) patch[k] = null;
  }
  return patch;
}

export interface DiffResult {
  /** Ops needed to reach desired state (create/update/cancel). No consent or
   *  policy decoration yet — store.ts adds fees and consent flags. */
  ops: Omit<Op, 'status' | 'requiresConsent' | 'fee' | 'isAlternative'>[];
  /** Commitments already matching desired state — provably untouched. */
  unaffected: Commitment[];
  /** Live commitments with no desired counterpart — candidates for cancel. */
  orphans: Commitment[];
}

export function diff(
  live: Record<string, Commitment>,
  desired: DesiredCommitment[],
  factsVersion: number,
  proposalSeq = 0,
): DiffResult {
  const ops: DiffResult['ops'] = [];
  const unaffected: Commitment[] = [];
  const desiredIds = new Set(desired.map((d) => d.id));

  for (const d of desired) {
    const cur = live[d.id];
    if (!cur || cur.state === 'cancelled') {
      ops.push(makeOp('create', d, null, clone(d.params), factsVersion, proposalSeq, d.cost));
      continue;
    }
    if (paramsEqual(cur.params, d.params) && cur.cost === d.cost) {
      unaffected.push(cur);
      continue;
    }
    const patch = paramPatch(cur.params, d.params);
    ops.push(
      makeOp('update', d, clone(cur.params), clone(d.params), factsVersion, proposalSeq, d.cost - cur.cost, patch),
    );
  }

  // Only plan-managed commitments can be orphaned by the diff. 'extra'
  // commitments (paid alternatives like a top-up delivery) are separate
  // orders the service still honours — never auto-cancelled by a replan.
  const orphans = Object.values(live).filter(
    (c) => !desiredIds.has(c.id) && c.state !== 'cancelled' && c.origin !== 'extra',
  );
  for (const c of orphans) {
    ops.push({
      id: hashParts('op', factsVersion, proposalSeq, c.id, 'cancel'),
      kind: 'cancel',
      service: c.service,
      commitmentId: c.id,
      label: `Cancel ${c.label}`,
      before: clone(c.params),
      after: null,
      patch: {},
      costDelta: -c.cost,
    });
  }
  return { ops, unaffected, orphans };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** Build a create op for a desired commitment (used for rebooks). */
export function createOpFor(d: DesiredCommitment, factsVersion: number, proposalSeq = 0) {
  return makeOp('create', d, null, d.params, factsVersion, proposalSeq, d.cost);
}

function makeOp(
  kind: OpKind,
  d: DesiredCommitment,
  before: Record<string, JsonValue> | null,
  after: Record<string, JsonValue> | null,
  factsVersion: number,
  proposalSeq: number,
  costDelta: number,
  patch: Record<string, JsonValue> = {},
): DiffResult['ops'][number] {
  return {
    // proposalSeq makes each proposal a unique consent scope: a re-proposal
    // of the same intent can never resolve to a superseded predecessor.
    id: hashParts('op', factsVersion, proposalSeq, d.id, kind, after),
    kind,
    service: d.service,
    commitmentId: d.id,
    label:
      kind === 'create'
        ? `Book ${d.label}`
        : kind === 'update'
          ? `Update ${d.label}`
          : `Cancel ${d.label}`,
    before: before ? clone(before) : null,
    after: after ? clone(after) : null,
    patch,
    costDelta,
  };
}

/** Deterministic feasibility check: does the projected spend fit the budget? */
export function projectedSpend(
  live: Record<string, Commitment>,
  feesCharged: number,
  ops: { costDelta: number; fee: number }[],
): number {
  const committed = Object.values(live)
    .filter((c) => c.state !== 'cancelled')
    .reduce((s, c) => s + c.cost, 0);
  const deltas = ops.reduce((s, o) => s + Math.max(0, o.costDelta) + o.fee, 0);
  return committed + feesCharged + deltas;
}
