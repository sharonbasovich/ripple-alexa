// Regression tests for defects found in independent review of the first
// public commit. Each test encodes the reported failure shape; all were
// confirmed to fail (or reproduce the defect) before the fix landed.
import { describe, it, expect } from 'vitest';
import * as E from '../src/index.js';
import { demoWorld, NOW, HOUR } from './helpers.js';
import type { Op } from '../src/index.js';

function approveAllAndRun(w: E.World, cs: E.ChangeSet, now: number) {
  for (const op of cs.ops) {
    if (op.status !== 'proposed') continue;
    E.approve(w, E.consentFor(w, op), now);
  }
  return E.executeApproved(w, now);
}

describe('regression: executed updates move commitment.cost', () => {
  it('guests 2→3 reprices restaurant and grocery, budget reflects it', () => {
    const w = demoWorld();
    const before = { ...Object.fromEntries(
      Object.entries(w.commitments).map(([k, c]) => [k, c.cost]),
    ) };
    const cs = E.changeFacts(w, [{ key: 'guests', value: 3 }], NOW).changeSet!;
    approveAllAndRun(w, cs, NOW);
    const rest = w.commitments['restaurant:arrival-dinner']!;
    const groc = w.commitments['grocery:arrival-delivery']!;
    expect(rest.cost).toBe(before['restaurant:arrival-dinner']! + E.PRICE.restaurantPerSeat);
    // grocery is dispatched — update rejected, cost stays (honest)
    expect(groc.cost).toBe(before['grocery:arrival-delivery']);
    expect(E.budgetStatus(w).committed).toBe(
      Object.values(w.commitments).filter((c) => c.state !== 'cancelled').reduce((s, c) => s + c.cost, 0),
    );
  });
});

describe('regression: causal recall uses real causes, not dependency lists', () => {
  it('guests-only change does not appear in arrival recall', () => {
    const w = demoWorld();
    const cs = E.changeFacts(w, [{ key: 'guests', value: 3 }], NOW).changeSet!;
    approveAllAndRun(w, cs, NOW);
    const arrivalRecall = E.recallByFact(w, 'arrival');
    expect(arrivalRecall.changedCommitments).toHaveLength(0);
    const guestRecall = E.recallByFact(w, 'guests');
    expect(guestRecall.changedCommitments.length).toBeGreaterThan(0);
  });

  it('approved-but-unapplied ops are reported as pending, not changed', () => {
    const w = demoWorld();
    const cs = E.changeFacts(w, [{ key: 'arrival', value: '2026-10-17T09:40' }], NOW).changeSet!;
    const cal = cs.ops.find((o) => o.commitmentId === 'calendar:visit')!;
    E.approve(w, E.consentFor(w, cal), NOW);
    const recall = E.recallByFact(w, 'arrival');
    const entry = recall.changedCommitments.find((c) => c.id === 'calendar:visit')!;
    expect(entry.state).toBe('approved');
    E.executeApproved(w, NOW);
    const recall2 = E.recallByFact(w, 'arrival');
    expect(recall2.changedCommitments.find((c) => c.id === 'calendar:visit')!.state).toBe('applied');
  });

  it('proposed ops (no approval) report as proposed, never as approved', () => {
    const w = demoWorld();
    E.changeFacts(w, [{ key: 'arrival', value: '2026-10-17T09:40' }], NOW);
    const recall = E.recallByFact(w, 'arrival');
    expect(recall.changedCommitments.length).toBeGreaterThan(0);
    for (const c of recall.changedCommitments) expect(c.state).toBe('proposed');
  });

  it('multi-fact batch attributes each op to its real causes', () => {
    const w = demoWorld();
    E.changeFacts(
      w,
      [
        { key: 'arrival', value: '2026-10-17T09:40' },
        { key: 'departure', value: '2026-10-19T17:00' },
      ],
      NOW,
    );
    const arrivalRecall = E.recallByFact(w, 'arrival');
    // departure-day lock-up is caused ONLY by departure — never arrival
    expect(
      arrivalRecall.changedCommitments.map((c) => c.id),
    ).not.toContain('routines:farewell');
    const depRecall = E.recallByFact(w, 'departure');
    expect(depRecall.changedCommitments.map((c) => c.id)).toContain('routines:farewell');
  });

  it('re-proposal under a different trigger keeps original causes', () => {
    const w = demoWorld();
    E.changeFacts(w, [{ key: 'arrival', value: '2026-10-17T09:40' }], NOW);
    // budget-only edit re-proposes the still-pending arrival update
    const r = E.changeFacts(w, [{ key: 'budget', value: 350 }], NOW + HOUR);
    const cs2 = r.changeSet!;
    const calOp = cs2.ops.find((o) => o.commitmentId === 'calendar:visit' && o.kind === 'update')!;
    expect(calOp.changedBy).toContain('arrival');
    expect(calOp.changedBy).not.toContain('budget');
  });
});

describe('regression: negated/ambiguous utterances never mutate', () => {
  it.each([
    'My brother is not joining',
    'dont change arrival',
    "Don't move the arrival; my sister asked about it",
    'My sister asked about joining',
    'My brother cancelled',
    'No more guests',
    'My brother likes pizza',
    'My sister is a vegetarian',
    '-2 guests',
    '2.5 guests',
    'Budget $250.50',
  ])('%s → clarify, never an edit', (text) => {
    const w = demoWorld();
    const i = E.parseUtterance(text, w.facts, NOW);
    expect(i.type).not.toBe('edit');
    expect(['clarify', 'unknown']).toContain(i.type);
  });

  it('positive forms still parse as edits', () => {
    const w = demoWorld();
    expect(E.parseUtterance('My brother is joining', w.facts, NOW).type).toBe('edit');
    expect(E.parseUtterance('Move arrival to Saturday 9:40', w.facts, NOW).type).toBe('edit');
  });

  it('compound edits parse BOTH parts or neither', () => {
    const w = demoWorld();
    const i = E.parseUtterance('3 guests and budget $250', w.facts, NOW);
    expect(i.type).toBe('edit');
    if (i.type === 'edit') {
      const keys = i.edits.map((e) => e.key).sort();
      expect(keys).toEqual(['budget', 'guests']);
    }
    const j = E.parseUtterance('arrive Saturday 9:40 and leave Monday 8am', w.facts, NOW);
    expect(j.type).toBe('edit');
    if (j.type === 'edit') {
      expect(j.edits.map((e) => e.key).sort()).toEqual(['arrival', 'departure']);
    }
  });
});

describe('regression: fees are re-quoted at execution time', () => {
  it('approving a $0 cancel then executing inside the late window re-quotes instead of executing', () => {
    const w = demoWorld();
    // Propose while the dinner booking is >24h away (fee = $0), then execute
    // inside the 24h late-cancel window but within the 12h decision TTL.
    const early = NOW - 20 * HOUR;
    const r = E.changeFacts(w, [{ key: 'arrival', value: '2026-10-17T09:40' }], early);
    const cs = r.changeSet!;
    const target = cs.ops.find(
      (o) => o.kind === 'cancel' && o.commitmentId === 'restaurant:arrival-dinner',
    )!;
    expect(target).toBeDefined();
    expect(target.fee).toBe(0); // proposed at $0 — >24h out
    const consented = E.approve(w, E.consentFor(w, target), early);
    expect(consented.ok).toBe(true);

    const later = early + 10 * HOUR; // dinner now <24h away, decision still in TTL
    const outcomes = E.executeApproved(w, later);
    const mine = outcomes.find((o) => o.opId === target.id)!;
    expect(mine.status).toBe('requoted');
    expect(target.status).toBe('proposed');
    expect(target.fee).toBe(75); // $25 × 3 seats, re-quoted
    // nothing was charged at the stale price, booking still live
    expect(w.feesCharged).toBe(0);
    expect(w.commitments['restaurant:arrival-dinner']!.state).not.toBe('cancelled');

    // the stale consent cannot execute; fresh consent at the new price can
    const again = E.approve(w, E.consentFor(w, target), later);
    expect(again.ok).toBe(true);
    const out2 = E.executeApproved(w, later);
    expect(out2.find((o) => o.opId === target.id)!.status).toBe('executed');
    expect(w.feesCharged).toBe(75);
  });
});

describe('regression: re-proposals are a unique consent scope', () => {
  it('expired cs + repropose yields different op ids; approve hits the live one', () => {
    const w = demoWorld();
    const cs1 = E.changeFacts(w, [{ key: 'arrival', value: '2026-10-17T09:40' }], NOW).changeSet!;
    const expired = NOW + E.CHANGESET_TTL_MS + HOUR;
    const cs2 = E.repropose(w, expired, 're-check');
    const op1 = cs1.ops.find((o) => o.commitmentId === 'calendar:visit')!;
    const op2 = cs2.ops.find((o) => o.commitmentId === 'calendar:visit')!;
    expect(op1.id).not.toBe(op2.id);
    const res = E.approve(w, E.consentFor(w, op2), expired);
    expect(res.ok).toBe(true);
    expect(op2.status).toBe('approved');
    expect(op1.status).toBe('superseded'); // marked superseded when re-proposed
  });
});

describe('regression: stale service pings are fenced by booking occurrence', () => {
  it('a confirmed ping for a cancelled+rebooked commitment does not bless the new booking', () => {
    const w = demoWorld();
    const old = w.commitments['restaurant:arrival-dinner']!;
    const oldBooking = old.booking;
    // cancel + rebook at the same simulated instant — same createdAt,
    // different booking occurrence
    const cs = E.changeFacts(w, [{ key: 'arrival', value: '2026-10-17T09:40' }], NOW).changeSet!;
    const cancelOp = cs.ops.find((o) => o.kind === 'cancel' && o.commitmentId === 'restaurant:arrival-dinner')!;
    const createOp = cs.ops.find((o) => o.kind === 'create' && o.commitmentId === 'restaurant:arrival-dinner')!;
    approveAllAndRun(w, cs, NOW);
    void cancelOp; void createOp;
    const reb = w.commitments['restaurant:arrival-dinner']!;
    expect(reb.booking).not.toBe(oldBooking);
    // late ping for the OLD booking hits the new pending commitment → stale
    const res = E.applyServiceEvent(w, 'restaurant:arrival-dinner', 'confirmed', NOW + 60_000, oldBooking);
    expect(res.stale).toBe(true);
    expect(reb.state).toBe('pending');
    // ping carrying the NEW booking applies normally
    const res2 = E.applyServiceEvent(w, 'restaurant:arrival-dinner', 'confirmed', NOW + 120_000, reb.booking);
    expect(res2.applied).toBe(true);
    expect(reb.state).toBe('confirmed');
  });
});

describe('regression: declined alternatives stay declined', () => {
  it('declining a generated top-up then re-checking does not re-propose it', () => {
    const w = demoWorld();
    const cs = E.changeFacts(
      w,
      [
        { key: 'arrival', value: '2026-10-17T09:40' },
        { key: 'guests', value: 3 },
      ],
      NOW,
    ).changeSet!;
    approveAllAndRun(w, cs, NOW); // grocery update rejected → top-up offered
    const alt = cs.ops.find((o) => o.isAlternative)!;
    expect(alt).toBeDefined();
    E.decline(w, E.consentFor(w, alt), NOW);
    // Re-check: same facts — the declined $60 top-up must not come back
    const cs2 = E.repropose(w, NOW + HOUR, 're-check');
    E.executeApproved(w, NOW + HOUR);
    const stillAlt = cs2.ops.find((o) => o.isAlternative);
    expect(stillAlt === undefined || stillAlt.status === 'declined').toBe(true);
    expect(w.commitments['grocery:arrival-delivery']!.state).toBe('dispatched');
  });
});

describe('regression: alternative commitments are never orphaned', () => {
  it('after accepting a top-up, a budget-only change does not cancel it', () => {
    const w = demoWorld();
    const cs = E.changeFacts(w, [
      { key: 'arrival', value: '2026-10-17T09:40' },
      { key: 'guests', value: 3 },
    ], NOW).changeSet!;
    approveAllAndRun(w, cs, NOW);
    const topUp = cs.ops.find((o) => o.isAlternative)!;
    expect(topUp).toBeDefined();
    E.approve(w, E.consentFor(w, topUp), NOW);
    E.executeApproved(w, NOW);
    expect(w.commitments[topUp.commitmentId]).toBeDefined();

    const r2 = E.changeFacts(w, [{ key: 'budget', value: 500 }], NOW + HOUR);
    const cs2 = r2.changeSet!;
    expect(cs2.ops.find((o) => o.commitmentId === topUp.commitmentId && o.kind === 'cancel')).toBeUndefined();
    expect(w.commitments[topUp.commitmentId]!.state).not.toBe('cancelled');
  });

  it('an alternative op cannot overwrite an existing commitment', () => {
    const w = demoWorld();
    const cs = E.changeFacts(w, [{ key: 'guests', value: 3 }], NOW).changeSet!;
    const synthetic: Op = {
      id: 'op-alt-dup',
      kind: 'alternative',
      service: 'grocery',
      commitmentId: 'grocery:arrival-delivery', // exists and is dispatched
      isAlternative: true,
      label: 'Duplicate top-up',
      before: null,
      after: { cost: 60 },
      patch: {},
      fee: 0,
      costDelta: 60,
      requiresConsent: true,
      status: 'approved',
    };
    cs.ops.push(synthetic);
    const outcomes = E.executeApproved(w, NOW);
    expect(outcomes.find((o) => o.opId === 'op-alt-dup')!.status).toBe('rejected');
    // original dispatched order untouched
    expect(w.commitments['grocery:arrival-delivery']!.state).toBe('dispatched');
  });
});

describe('regression: nested persistence validation', () => {
  function corrupt(mutate: (w: Record<string, unknown>) => void): string {
    const w = demoWorld();
    E.changeFacts(w, [{ key: 'guests', value: 3 }], NOW); // ensure changeSets exist
    const parsed = JSON.parse(E.serializeWorld(w)) as {
      v: number;
      world: Record<string, unknown>;
    };
    mutate(parsed.world);
    return JSON.stringify(parsed);
  }
  it('rejects op.kind=bogus instead of reaching the renderer', () => {
    const w2 = demoWorld();
    E.changeFacts(w2, [{ key: 'guests', value: 3 }], NOW);
    const s2 = JSON.parse(E.serializeWorld(w2)) as {
      v: number;
      world: { changeSets: { ops: { kind: string }[] }[] };
    };
    s2.world.changeSets[0]!.ops[0]!.kind = 'bogus';
    expect(E.deserializeWorld(JSON.stringify(s2))).toBeNull();
    const raw = corrupt((w) => {
      const cs = (w.changeSets as { ops: { kind: string }[] }[])[0];
      if (cs?.ops[0]) cs.ops[0].kind = 'bogus';
    });
    expect(E.deserializeWorld(raw)).toBeNull();
  });
  it('rejects malformed commitment state / ledger payload / null fields', () => {
    const w = demoWorld();
    const s = JSON.parse(E.serializeWorld(w)) as { v: number; world: { commitments: Record<string, { state: string }>; ledger: { payload: unknown }[] } };
    s.world.commitments['calendar:visit']!.state = 'bogus';
    expect(E.deserializeWorld(JSON.stringify(s))).toBeNull();
    const s2 = JSON.parse(E.serializeWorld(w)) as { v: number; world: { ledger: { payload: unknown }[] } };
    s2.world.ledger[0]!.payload = 'not-an-object';
    expect(E.deserializeWorld(JSON.stringify(s2))).toBeNull();
    const s3 = JSON.parse(E.serializeWorld(w)) as { v: number; world: { commitments: unknown } };
    s3.world.commitments = null;
    expect(E.deserializeWorld(JSON.stringify(s3))).toBeNull();
  });
  it('v1 snapshots are rejected as stale schema', () => {
    const s = JSON.parse(E.serializeWorld(demoWorld())) as { v: number };
    s.v = 1;
    expect(E.deserializeWorld(JSON.stringify(s))).toBeNull();
  });
});
