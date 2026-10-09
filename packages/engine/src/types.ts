// Ripple engine types — pure deterministic simulation of an Alexa+-style
// causal reconciliation loop. No I/O, no randomness, no wall-clock access:
// every function takes the current time as an argument.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

export type FactKey = 'arrival' | 'departure' | 'guests' | 'budget';

export interface VisitFacts {
  /** ISO local datetime of guests' arrival, e.g. "2026-10-16T18:05". */
  arrival: string;
  /** ISO local datetime of guests' departure. */
  departure: string;
  /** Number of visiting adults (does not include the host). 1-8. */
  guests: number;
  /** Total visit budget in whole USD. */
  budget: number;
}

export type ServiceId =
  | 'calendar'
  | 'grocery'
  | 'restaurant'
  | 'routines'
  | 'pickup';

export type LifecycleState =
  | 'pending' // booked with the service, awaiting its confirmation
  | 'confirmed'
  | 'dispatched' // in flight; policy may forbid cancel/reschedule
  | 'completed'
  | 'cancelled';

export interface Commitment {
  /** Stable identity, e.g. "restaurant:arrival-dinner". */
  id: string;
  service: ServiceId;
  label: string;
  state: LifecycleState;
  /** Current effective parameters (after the last executed op). */
  params: Record<string, JsonValue>;
  /** Expected spend attributed to this commitment, whole USD. */
  cost: number;
  /** Facts this commitment causally depends on. */
  dependsOn: FactKey[];
  /** Bumps each time an op mutates params/state. */
  version: number;
  /** Simulated time the commitment was booked — pending→confirmed and
   *  dispatch cutoffs are anchored to this, not to the current clock. */
  createdAt: number;
  /** 'plan' commitments come from desired-state reconciliation (the planner
   *  may cancel them when they leave desired state); 'extra' commitments were
   *  created by an alternative op (e.g. a paid top-up order) and are never
   *  auto-cancelled by a later diff. */
  origin?: 'plan' | 'extra';
  /** Monotonically-unique booking occurrence: identifies THIS booking of the
   *  logical commitment. A cancel+rebook under the same id gets a new
   *  booking, so a late service callback for the old one is fenced out. */
  booking: number;
}

export type OpKind = 'create' | 'update' | 'cancel' | 'alternative';

export type OpStatus =
  | 'proposed' // awaiting a human decision
  | 'approved' // human consented, not yet executed
  | 'declined' // human refused; recorded, not re-asked for same facts
  | 'executed'
  | 'rejected' // service refused at execution time (policy / lifecycle)
  | 'expired' // decision window lapsed
  | 'superseded'; // facts changed before decision

export interface Op {
  /** Deterministic id: hash of (changeSetFactsVersion, commitment, kind, after). */
  id: string;
  kind: OpKind;
  service: ServiceId;
  commitmentId: string;
  /** True when kind === 'alternative' (a new feasible option, not a diff op). */
  isAlternative: boolean;
  label: string;
  /** Params before the op (null for create). */
  before: Record<string, JsonValue> | null;
  /** Params after the op (null for cancel). */
  after: Record<string, JsonValue> | null;
  /** Only the params that change (update ops) — the minimal patch. */
  patch: Record<string, JsonValue>;
  /** Non-refundable fee charged by the service if this op executes, USD. */
  fee: number;
  /** Expected-spend delta this op introduces, USD (can be negative). */
  costDelta: number;
  requiresConsent: boolean;
  /** Facts the resulting commitment depends on (used for create/alternative
   *  ops that introduce a new commitment id). */
  dependsOn?: FactKey[];
  /** Facts that ACTUALLY changed in the triggering batch — the honest
   *  "because X changed" label, distinct from dependsOn (the causal graph). */
  changedBy?: FactKey[];
  /** Human-readable note when executing is irreversible or fee-bearing. */
  irreversibleNote?: string;
  status: OpStatus;
  /** Rejection/expiry reason once resolved. */
  reason?: string;
}

export type ChangeSetStatus =
  | 'open'
  | 'decided' // every op is approved/declined/executed/rejected
  | 'expired'
  | 'superseded';

export interface ChangeSet {
  id: string;
  /** Facts version this diff was computed against. Approvals must match. */
  factsVersion: number;
  ops: Op[];
  createdAt: number;
  expiresAt: number;
  status: ChangeSetStatus;
  /** Human summary of the triggering fact changes. */
  trigger: string;
}

export type EventType =
  | 'plan.created'
  | 'facts.changed'
  | 'changeset.proposed'
  | 'op.approved'
  | 'op.declined'
  | 'op.expired'
  | 'changeset.expired'
  | 'changeset.superseded'
  | 'op.executed'
  | 'op.rejected'
  | 'fee.charged'
  | 'op.requoted'
  | 'service.transition'
  | 'service.stale_event'
  | 'kept_by_choice'
  | 'budget.evaluated';

export interface LedgerEvent {
  seq: number;
  t: number; // simulated ms epoch
  type: EventType;
  /** Fact whose change caused this event, when applicable. */
  causedBy?: FactKey;
  /** Facts version the event belongs to, when applicable. */
  factsVersion?: number;
  commitmentId?: string;
  opId?: string;
  payload: Record<string, JsonValue>;
}

export interface PolicyDecision {
  allowed: boolean;
  fee?: number;
  reason?: string;
}

export interface ServicePolicy {
  service: ServiceId;
  /** Cancel rule for an existing commitment. */
  canCancel(c: Commitment, now: number): PolicyDecision;
  /** Update (params change) rule. */
  canUpdate(c: Commitment, patch: Record<string, JsonValue>, now: number): PolicyDecision;
  /** Cancellation fee if cancelled now. */
  cancelFee(c: Commitment, now: number): number;
  /** Next lifecycle transition the service performs on its own, or null. */
  nextTransition(c: Commitment, now: number): { to: LifecycleState; at: number } | null;
}

/** External inputs applied to a world, in order. Replay re-runs these
 *  through the same deterministic engine — equality with the live world is
 *  a tested invariant. The ledger is derived output; the journal is input. */
export type JournalEntry =
  | { t: number; type: 'plan'; facts: VisitFacts }
  | { t: number; type: 'facts'; edits: FactEdit[] }
  | { t: number; type: 'decide'; how: 'approve' | 'decline'; consent: ConsentWire }
  | { t: number; type: 'advance' }
  | {
      t: number;
      type: 'serviceEvent';
      commitmentId: string;
      to: 'completed' | 'confirmed';
      /** Booking-occurrence fence (mandatory): the commitment's unique
       *  booking id this event refers to. A late "confirmed" for a cancelled
       *  booking must not bless a rebooked commitment that reuses the id. */
      booking: number;
    }
  | { t: number; type: 'repropose'; trigger?: string }
  | { t: number; type: 'execute' };

/** Consent as the decider presented it (may legitimately be stale). */
export interface ConsentWire {
  opId: string;
  payloadHash: string;
  factsVersion: number;
}

export interface World {
  facts: VisitFacts;
  factsVersion: number;
  commitments: Record<string, Commitment>;
  changeSets: ChangeSet[];
  ledger: LedgerEvent[];
  journal: JournalEntry[];
  feesCharged: number;
  seq: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface ExecutionOutcome {
  opId: string;
  /** 'requoted' = live terms changed since consent (e.g. a cancellation fee
   *  appeared inside the late window); the op went back to proposed with the
   *  new price and needs a fresh decision — nothing executed. */
  status: 'executed' | 'rejected' | 'requoted';
  reason?: string;
  feeCharged?: number;
}

export interface BudgetStatus {
  budget: number;
  committed: number; // sum of live commitment costs
  fees: number; // fees already charged
  pendingAdds: number; // positive costDelta of open/approved ops
  projected: number; // committed + fees + pendingAdds
  feasible: boolean;
  overBy: number;
}

export interface Receipt {
  fact: FactKey;
  factsVersion: number;
  /** Ops whose creation was caused by the fact change. */
  ops: Op[];
  /** Ledger events caused by the fact change, in order. */
  events: LedgerEvent[];
}

/** One causal operation, never combined with another operation's patch. */
export interface RecallOperation {
  id: string;
  commitmentId: string;
  label: string;
  kind: OpKind;
  factsVersion: number;
  changedBy: FactKey[];
  before: Record<string, JsonValue> | null;
  after: Record<string, JsonValue> | null;
  patch: Record<string, JsonValue>;
}

export interface CausalRecall {
  fact: FactKey;
  /** Legacy commitment summary retained for existing callers. New consumers
   * should use appliedHistory and pendingOperations to avoid hiding proposals. */
  changedCommitments: {
    id: string;
    label: string;
    whatChanged: Record<string, JsonValue>;
    state: 'applied' | 'approved' | 'proposed';
  }[];
  unaffected: { id: string; label: string }[];
  appliedHistory: (RecallOperation & { state: 'applied'; executedSeq: number; executedAt: number })[];
  pendingOperations: (RecallOperation & { state: 'approved' | 'proposed' })[];
  /** Live commitments absent from both truthful operation lists. */
  unaffectedCommitments: { id: string; label: string }[];
}

export interface FactEdit {
  key: FactKey;
  value: JsonValue;
}
