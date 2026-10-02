import { describe, it, expect } from 'vitest';
import * as E from '../src/index.js';
import { demoWorld, demoEdits, propose, consent, opFor, approveAndRun, NOW, HOUR, DEMO_ARRIVAL } from './helpers.js';

function changeById(w: E.World, id: string): E.Commitment {
  const c = w.commitments[id];
  if (!c) throw new Error(`missing commitment ${id}`);
  return c;
}

describe('fixture world', () => {
  it('seeds seven commitments across five services with correct lifecycles', () => {
    const w = demoWorld();
    expect(Object.keys(w.commitments)).toHaveLength(7);
    expect(changeById(w, 'grocery:arrival-delivery').state).toBe('dispatched');
    for (const id of [
      'calendar:visit',
      'restaurant:arrival-dinner',
      'routines:welcome',
      'routines:coffee',
      'pickup:airport',
      'routines:farewell',
    ]) {
      expect(changeById(w, id).state, id).toBe('confirmed');
    }
  });

  it('initial plan is inside the fictional $300 budget', () => {
    const w = demoWorld();
    const b = E.budgetStatus(w);
    expect(b.feasible).toBe(true);
    expect(b.committed).toBe(76 + 120);
  });
});

describe('minimal diff and causal scoping', () => {
  it('arrival+guests change leaves departure-dependent commitments untouched', () => {
    const w = demoWorld();
    const vBefore = changeById(w, 'routines:farewell').version;
    const cs = propose(w);
    const ids = cs.ops.map((o) => o.commitmentId);
    expect(ids).not.toContain('routines:farewell'); // depends on departure only
    expect(changeById(w, 'routines:farewell').version).toBe(vBefore);
  });

  it('arrival edit never touches departure — shorter visit, not 3 nights', () => {
    const w = demoWorld();
    const before = w.facts.departure;
    const r = E.changeFacts(w, [{ key: 'arrival', value: DEMO_ARRIVAL }], NOW);
    expect(r.ok).toBe(true);
    expect(w.facts.departure).toBe(before);
    // calendar keeps its original end — explicitly preserved, not stretched
    const cal = E.desiredCommitments(w.facts).find((d) => d.id === 'calendar:visit')!;
    expect(cal.params['end']).toBe(before);
    expect(E.parseLocal(cal.params['end'] as string)! - E.parseLocal(cal.params['start'] as string)!)
      .toBeLessThan(E.parseLocal(before)! - E.parseLocal(E.FIXTURE_FACTS.arrival)!);
  });

  it('update ops carry only the params that changed', () => {
    const w = demoWorld();
    propose(w);
    const pickup = opFor(w, 'pickup:airport');
    expect(pickup.kind).toBe('update');
    expect(Object.keys(pickup.patch).sort()).toEqual(['arrival', 'remindAt']);
    const coffee = opFor(w, 'routines:coffee');
    expect(coffee.patch).toHaveProperty('cups', 4);
    expect(coffee.patch).toHaveProperty('runAt');
  });

  it('guests-only change does not touch departure/arrival-only commitments', () => {
    const w = demoWorld();
    const r = E.changeFacts(w, [{ key: 'guests', value: 4 }], NOW);
    const ids = r.changeSet!.ops.map((o) => o.commitmentId);
    expect(ids).not.toContain('routines:farewell');
    expect(ids).not.toContain('pickup:airport'); // arrival-only dependency
  });
});

describe('consent, fees, honesty', () => {
  it('restaurant same-day-only policy turns a move into fee-gated cancel + rebook', () => {
    const w = demoWorld();
    const cs = propose(w);
    const cancel = cs.ops.find((o) => o.commitmentId === 'restaurant:arrival-dinner' && o.kind === 'cancel')!;
    const rebook = cs.ops.find((o) => o.commitmentId === 'restaurant:arrival-dinner' && o.kind === 'create')!;
    expect(cancel.requiresConsent).toBe(true);
    expect(cancel.fee).toBe(75); // $25 x 3 seats, inside 24h
    expect(cancel.irreversibleNote).toMatch(/final/i);
    expect(rebook.after!['time']).toContain('2026-10-17');
    expect(rebook.after!['partySize']).toBe(4);
  });

  it('dispatched grocery delivery cannot be changed — rejection is truthful, alternative is separate', () => {
    const w = demoWorld();
    propose(w);
    const grocery = opFor(w, 'grocery:arrival-delivery');
    approveAndRun(w, grocery);
    expect(grocery.status).toBe('rejected');
    expect(grocery.reason).toMatch(/dispatched/i);
    // original delivery stays dispatched — not magically cancelled
    expect(changeById(w, 'grocery:arrival-delivery').state).toBe('dispatched');
    // alternative appears as its own proposed op requiring fresh consent
    const cs = E.openChangeSet(w, NOW)!;
    const alt = cs.ops.find((o) => o.isAlternative);
    expect(alt).toBeDefined();
    expect(alt!.requiresConsent).toBe(true);
    expect(alt!.status).toBe('proposed');
  });

  it('fee is recorded as sunk in the ledger, never netted as savings', () => {
    const w = demoWorld();
    propose(w);
    approveAndRun(w, opFor(w, 'restaurant:arrival-dinner', 'cancel'));
    const feeEvents = w.ledger.filter((e) => e.type === 'fee.charged');
    expect(feeEvents).toHaveLength(1);
    expect(feeEvents[0]!.payload['amount']).toBe(75);
    expect(feeEvents[0]!.payload['sunk']).toBe(true);
    expect(w.feesCharged).toBe(75);
    expect(E.budgetStatus(w).fees).toBe(75);
  });

  it('approving the cancellation executes it; declining keeps the booking', () => {
    const w = demoWorld();
    propose(w);
    const cancel = opFor(w, 'restaurant:arrival-dinner', 'cancel');
    approveAndRun(w, cancel);
    expect(changeById(w, 'restaurant:arrival-dinner').state).toBe('cancelled');

    const w2 = demoWorld();
    propose(w2);
    const cancel2 = opFor(w2, 'restaurant:arrival-dinner', 'cancel');
    const d = E.decline(w2, consent(w2, cancel2), NOW);
    expect(d.ok).toBe(true);
    expect(changeById(w2, 'restaurant:arrival-dinner').state).toBe('confirmed');
    // not re-asked while facts are identical
    const cs2 = E.repropose(w2, NOW + 60000);
    const again = cs2.ops.find((o) => o.commitmentId === 'restaurant:arrival-dinner');
    expect(again?.status).toBe('declined');
    expect(w2.ledger.some((e) => e.type === 'kept_by_choice')).toBe(true);
  });

  it('unapproved ops never execute', () => {
    const w = demoWorld();
    propose(w);
    const before = { ...changeById(w, 'calendar:visit').params };
    E.executeApproved(w, NOW);
    expect(changeById(w, 'calendar:visit').params).toEqual(before);
  });
});

describe('idempotence and duplicates', () => {
  it('re-applying the same fact change is a no-op', () => {
    const w = demoWorld();
    const r1 = E.changeFacts(w, demoEdits(), NOW);
    const n = w.changeSets.length;
    const r2 = E.changeFacts(w, demoEdits(), NOW);
    expect(r1.ok && r2.ok).toBe(true);
    expect(r2.noOp).toBe(true);
    expect(w.changeSets.length).toBe(n);
  });

  it('repeated approve clicks do not duplicate effects', () => {
    const w = demoWorld();
    propose(w);
    const cancel = opFor(w, 'restaurant:arrival-dinner', 'cancel');
    E.approve(w, consent(w, cancel), NOW);
    const again = E.approve(w, consent(w, cancel), NOW);
    expect(again.ok).toBe(false);
    expect((again as { reason: string }).reason).toBe('already-decided');
    E.executeApproved(w, NOW);
    const outcomes = E.executeApproved(w, NOW);
    expect(outcomes).toHaveLength(0);
    expect(w.ledger.filter((e) => e.type === 'fee.charged')).toHaveLength(1);
  });

  it('duplicate execution after reload stays single-shot', () => {
    const w = demoWorld();
    propose(w);
    approveAndRun(w, opFor(w, 'calendar:visit'));
    const restored = E.deserializeWorld(E.serializeWorld(w))!;
    expect(restored).not.toBeNull();
    const outcomes = E.executeApproved(restored, NOW);
    expect(outcomes).toHaveLength(0);
    E.executeApproved(w, NOW); // same input on the live world — full state must match
    expect(E.stateEquals(w, restored)).toBe(true);
  });
});

describe('expiry and stale consent', () => {
  it('expired change sets execute nothing and reject approval', () => {
    const w = demoWorld();
    const cs = propose(w);
    const op = cs.ops[0]!;
    const c = consent(w, op);
    E.advanceTime(w, NOW + E.CHANGESET_TTL_MS + 1000);
    const res = E.approve(w, c, NOW + E.CHANGESET_TTL_MS + 2000);
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe('expired');
    expect(E.executeApproved(w, NOW + E.CHANGESET_TTL_MS + 3000)).toHaveLength(0);
  });

  it('stale consent (older facts version or payload) is rejected', () => {
    const w = demoWorld();
    propose(w);
    const op = opFor(w, 'calendar:visit');
    const stale = consent(w, op);
    E.changeFacts(w, [{ key: 'guests', value: 4 }], NOW + 1000);
    const res = E.approve(w, stale, NOW + 2000);
    expect(res.ok).toBe(false);
    expect(['stale', 'not-found', 'already-decided']).toContain((res as { reason: string }).reason);
  });
});

describe('validation — invalid input never mutates', () => {
  it.each([
    ['arrival after departure', [{ key: 'arrival', value: '2026-10-19T10:00' }]],
    ['departure before arrival', [{ key: 'departure', value: '2026-10-15T10:00' }]],
    ['zero guests', [{ key: 'guests', value: 0 }]],
    ['99 guests', [{ key: 'guests', value: 99 }]],
    ['fractional guests', [{ key: 'guests', value: 2.5 }]],
    ['negative budget', [{ key: 'budget', value: -5 }]],
    ['malformed arrival', [{ key: 'arrival', value: 'friday at noon' }]],
  ])('%s is rejected without mutating state', (_name, edits) => {
    const w = demoWorld();
    const snap = E.serializeWorld(w);
    const r = E.changeFacts(w, edits as E.FactEdit[], NOW);
    expect(r.ok).toBe(false);
    expect(E.serializeWorld(w)).toBe(snap);
  });
});

describe('budget honesty', () => {
  it('plan that cannot satisfy budget says so and does not claim it does', () => {
    const w = demoWorld();
    const r = E.changeFacts(w, [{ key: 'budget', value: 50 }], NOW);
    expect(r.ok).toBe(true);
    const b = E.budgetStatus(w);
    expect(b.feasible).toBe(false);
    expect(b.overBy).toBeGreaterThan(0);
  });

  it('approved chargeable ops project over budget honestly', () => {
    const w = demoWorld();
    propose(w);
    approveAndRun(w, opFor(w, 'restaurant:arrival-dinner', 'cancel'));
    approveAndRun(w, opFor(w, 'restaurant:arrival-dinner', 'create'));
    approveAndRun(w, opFor(w, 'grocery:arrival-delivery')); // rejected → alternative
    const cs = E.openChangeSet(w, NOW)!;
    const alt = cs.ops.find((o) => o.isAlternative)!;
    approveAndRun(w, alt);
    const b = E.budgetStatus(w);
    expect(b.committed + b.fees).toBe(76 + 160 + 60 + 75);
    expect(b.feasible).toBe(false); // honestly over $300
  });
});

describe('replay and persistence', () => {
  it('replay equals live world after a mixed session', () => {
    const w = demoWorld();
    propose(w);
    approveAndRun(w, opFor(w, 'calendar:visit'));
    approveAndRun(w, opFor(w, 'grocery:arrival-delivery')); // rejected
    approveAndRun(w, opFor(w, 'restaurant:arrival-dinner', 'cancel'));
    approveAndRun(w, opFor(w, 'restaurant:arrival-dinner', 'create'));
    approveAndRun(w, opFor(w, 'routines:welcome'));
    approveAndRun(w, opFor(w, 'routines:coffee'));
    approveAndRun(w, opFor(w, 'pickup:airport'));
    E.advanceTime(w, NOW + 26 * HOUR);
    const r2 = E.replay(w.journal);
    expect(E.stateEquals(w, r2)).toBe(true);
    expect(r2.ledger).toEqual(w.ledger);
  });

  it('reload preserves pending choices', () => {
    const w = demoWorld();
    propose(w);
    const restored = E.deserializeWorld(E.serializeWorld(w))!;
    const cs = E.openChangeSet(restored, NOW)!;
    expect(cs.ops.filter((o) => o.status === 'proposed').length).toBeGreaterThan(0);
  });

  it('corrupt storage returns null instead of a half-state', () => {
    expect(E.deserializeWorld('{oops')).toBeNull();
    expect(E.deserializeWorld('{"v":99,"world":{}}')).toBeNull();
    expect(E.deserializeWorld(null)).toBeNull();
  });
});

describe('stale async outcomes', () => {
  it('a completion ping for a cancelled commitment is recorded as stale', () => {
    const w = demoWorld();
    propose(w);
    approveAndRun(w, opFor(w, 'restaurant:arrival-dinner', 'cancel'));
    const res = E.applyServiceEvent(w, 'restaurant:arrival-dinner', 'confirmed', NOW + 5000);
    expect(res.stale).toBe(true);
    expect(changeById(w, 'restaurant:arrival-dinner').state).toBe('cancelled');
    const stale = w.ledger.filter((e) => e.type === 'service.stale_event');
    expect(stale).toHaveLength(1);
  });
});

describe('intent parser', () => {
  it('parses the demo utterance', () => {
    const w = demoWorld();
    const i = E.parseUtterance('Move arrival to Saturday 9:40', w.facts, NOW);
    expect(i.type).toBe('edit');
    if (i.type === 'edit') expect(i.edits[0]!.value).toBe(DEMO_ARRIVAL);
  });

  it('parses guest joins, budgets, departures, recall', () => {
    const w = demoWorld();
    expect(E.parseUtterance('my brother is joining', w.facts, NOW)).toMatchObject({
      type: 'edit',
      edits: [{ key: 'guests', value: 3 }],
    });
    expect(E.parseUtterance('budget $250', w.facts, NOW)).toMatchObject({
      edits: [{ key: 'budget', value: 250 }],
    });
    const dep = E.parseUtterance('departure Sunday 5pm', w.facts, NOW);
    if (dep.type === 'edit') expect(dep.edits[0]!.value).toBe('2026-10-18T17:00');
    expect(E.parseUtterance('what changed because of the flight', w.facts, NOW)).toMatchObject({
      type: 'recall',
      fact: 'arrival',
    });
  });

  it('unknown text returns examples and mutates nothing', () => {
    const w = demoWorld();
    const snap = E.serializeWorld(w);
    const i = E.parseUtterance('order me a pizza', w.facts, NOW);
    expect(i.type).toBe('unknown');
    if (i.type === 'unknown') expect(i.examples.length).toBeGreaterThan(3);
    expect(E.serializeWorld(w)).toBe(snap);
  });
});

describe('causal recall', () => {
  it('answers "what changed because of the arrival" with only caused items', () => {
    const w = demoWorld();
    propose(w);
    for (const o of [...E.openChangeSet(w, NOW)!.ops]) {
      if (o.status === 'proposed') approveAndRun(w, o);
    }
    const recall = E.recallByFact(w, 'arrival');
    const ids = recall.changedCommitments.map((c) => c.id);
    expect(ids).toContain('calendar:visit');
    expect(ids).toContain('pickup:airport');
    expect(ids).not.toContain('routines:farewell');
    expect(recall.unaffected.map((c) => c.id)).toContain('routines:farewell');
  });
});
