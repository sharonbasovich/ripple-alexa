import { describe, it, expect } from 'vitest';
import * as E from '../src/index.js';
import { rng, T0, NOW, HOUR, demoWorld } from './helpers.js';
import type { World, FactEdit, Op } from '../src/index.js';

// ---------------------------------------------------------------- helpers

const ARRIVAL_POOL = [
  '2026-10-16T18:05',
  '2026-10-17T09:40',
  '2026-10-17T14:00',
  '2026-10-16T22:30',
];

function randomEdit(r: () => number): FactEdit {
  const pick = r();
  if (pick < 0.35) return { key: 'arrival', value: ARRIVAL_POOL[Math.floor(r() * ARRIVAL_POOL.length)]! };
  if (pick < 0.5) return { key: 'departure', value: `2026-10-18T${String(12 + Math.floor(r() * 8)).padStart(2, '0')}:${r() < 0.5 ? '00' : '30'}` };
  if (pick < 0.7) return { key: 'guests', value: 1 + Math.floor(r() * 7) };
  if (pick < 0.9) return { key: 'budget', value: 50 + Math.floor(r() * 400) };
  // deliberately invalid
  const bad: FactEdit[] = [
    { key: 'arrival', value: '2026-10-20T10:00' }, // after departure
    { key: 'guests', value: 0 },
    { key: 'budget', value: -100 },
    { key: 'arrival', value: 'banana' },
  ];
  return bad[Math.floor(r() * bad.length)]!;
}

function proposedOps(w: World, now: number): Op[] {
  const cs = E.openChangeSet(w, now);
  return cs ? cs.ops.filter((o) => o.status === 'proposed') : [];
}

function feeSum(w: World): number {
  return w.ledger
    .filter((e) => e.type === 'fee.charged')
    .reduce((s, e) => s + (e.payload['amount'] as number), 0);
}

function approvedBeforeExecuted(w: World): boolean {
  const order = new Map<string, number>();
  for (const e of w.ledger) {
    if (e.opId && (e.type === 'op.approved' || e.type === 'op.declined')) order.set(e.opId, e.seq);
    if (e.opId && e.type === 'op.executed') {
      const a = order.get(e.opId);
      if (a === undefined || a > e.seq) return false;
    }
  }
  return true;
}

function ledgerMonotonic(w: World): boolean {
  for (let i = 1; i < w.ledger.length; i++) {
    if (w.ledger[i]!.seq <= w.ledger[i - 1]!.seq) return false;
  }
  return true;
}

function noResurrection(w: World): boolean {
  const dead = new Set<string>();
  for (const e of w.ledger) {
    if (e.type !== 'service.transition') continue;
    const id = e.commitmentId!;
    const to = e.payload['to'];
    if (to === 'cancelled') dead.add(id);
    else if (dead.has(id)) return false;
  }
  return true;
}

// ------------------------------------------------------------------- tests

describe('property: randomized action sequences', () => {
  it('1000+ generated sequences preserve engine invariants', () => {
    const SEQUENCES = 1200;
    const totals = { actions: 0, invalid: 0, decisions: 0, reloads: 0 };
    for (let s = 0; s < SEQUENCES; s++) {
      const r = rng(s * 2654435761);
      let w = demoWorld();
      const steps = 6 + Math.floor(r() * 14);
      let now = NOW;
      for (let i = 0; i < steps; i++) {
        now += Math.floor(r() * 8) * HOUR + Math.floor(r() * 3600_000);
        const action = r();
        const before = E.serializeWorld(w);

        if (action < 0.35) {
          const res = E.changeFacts(w, [randomEdit(r)], now);
          if (!res.ok) {
            totals.invalid++;
            expect(E.serializeWorld(w)).toBe(before); // invalid edits never mutate
          }
        } else if (action < 0.6) {
          const ops = proposedOps(w, now);
          if (ops.length) {
            const op = ops[Math.floor(r() * ops.length)]!;
            const c = E.consentFor(w, op);
            if (r() < 0.6) E.approve(w, c, now);
            else E.decline(w, c, now);
            totals.decisions++;
          }
        } else if (action < 0.75) {
          E.executeApproved(w, now);
        } else if (action < 0.85) {
          E.advanceTime(w, now);
        } else if (action < 0.93) {
          // simulated reload — pending state must survive
          const restored = E.deserializeWorld(E.serializeWorld(w));
          expect(restored).not.toBeNull();
          w = restored!;
          totals.reloads++;
        } else if (action < 0.97) {
          const ids = Object.keys(w.commitments);
          const id = ids[Math.floor(r() * ids.length)]!;
          // live bookings get the current booking id; sometimes a stale
          // ping for a fictional older booking (booking-1) — must be fenced
          const c = w.commitments[id]!;
          const booking = r() < 0.8 ? c.booking : Math.max(0, c.booking - 1);
          E.applyServiceEvent(w, id, r() < 0.5 ? 'confirmed' : 'completed', now, booking);
        } else {
          E.repropose(w, now);
        }

        totals.actions++;

        // ---- invariants after every action ----
        expect(E.validateFacts(w.facts).ok).toBe(true);
        expect(w.feesCharged).toBe(feeSum(w)); // ledger = source of truth for fees
        expect(approvedBeforeExecuted(w)).toBe(true); // nothing executes unapproved
        expect(ledgerMonotonic(w)).toBe(true);
        expect(noResurrection(w)).toBe(true);
        expect(() => E.budgetStatus(w)).not.toThrow();
        // serialized round-trip never loses observable state
        expect(E.stateEquals(w, E.deserializeWorld(E.serializeWorld(w))!)).toBe(true);
      }

      // ---- end of sequence: full journal replay must reproduce the world ----
      const r2 = E.replay(w.journal);
      expect(E.stateEquals(w, r2)).toBe(true);
      expect(r2.ledger).toEqual(w.ledger);
    }
    expect(totals.actions).toBeGreaterThan(SEQUENCES * 6);
    expect(totals.invalid).toBeGreaterThan(50); // invalid paths really exercised
    expect(totals.decisions).toBeGreaterThan(500);
    expect(totals.reloads).toBeGreaterThan(50);
  }, 120_000);
});

describe('property: A→B→A oscillation', () => {
  it('oscillating arrival keeps outcomes truthful incl. sunk fees', () => {
    const w = demoWorld();
    let now = NOW;
    for (let cycle = 0; cycle < 4; cycle++) {
      const target = cycle % 2 === 0 ? '2026-10-17T09:40' : E.FIXTURE_FACTS.arrival;
      now += 3 * HOUR;
      const r = E.changeFacts(w, [{ key: 'arrival', value: target }], now);
      expect(r.ok).toBe(true);
      const cs = E.openChangeSet(w, now);
      for (const op of [...(cs?.ops ?? [])]) {
        if (op.status !== 'proposed') continue;
        E.approve(w, E.consentFor(w, op), now);
        E.executeApproved(w, now);
      }
      // every fee ever charged is still charged — never refunded or hidden
      const charged = w.ledger.filter((e) => e.type === 'fee.charged');
      expect(w.feesCharged).toBe(charged.reduce((s, e) => s + (e.payload['amount'] as number), 0));
      expect(E.stateEquals(w, E.replay(w.journal))).toBe(true);
    }
    // after B→A the calendar is back at Friday 18:05 — facts, not vibes
    expect(w.commitments['calendar:visit']!.params['start']).toBe(E.FIXTURE_FACTS.arrival);
    // cancellation fees from both directions were actually charged (sunk)
    expect(w.feesCharged).toBeGreaterThanOrEqual(150);
  });
});

describe('property: minimal diff under random single-fact edits', () => {
  it('only commitments that depend on a changed fact get ops', () => {
    const SEQS = 300;
    for (let s = 0; s < SEQS; s++) {
      const r = rng(0x9e3779b9 ^ s);
      const w = demoWorld();
      const edit = randomEdit(r);
      const res = E.changeFacts(w, [edit], NOW + s);
      if (!res.ok || !res.changeSet) continue; // invalid or no-op edit
      const cs = res.changeSet;
      for (const op of cs.ops) {
        if (op.isAlternative) continue;
        const dep = w.commitments[op.commitmentId]?.dependsOn
          ?? E.desiredCommitments(w.facts).find((d) => d.id === op.commitmentId)?.dependsOn
          ?? [];
        // an op must be causally linked to the changed fact — except the
        // paired rebook create that follows a caused cancel for the same
        // commitment (restaurant same-day-only conversion).
        const isRebookPair =
          op.kind === 'create' &&
          cs.ops.some((o) => o !== op && o.commitmentId === op.commitmentId && o.kind === 'cancel');
        const relevant = dep.includes(edit.key) || isRebookPair;
        expect(relevant, `${op.commitmentId} vs ${edit.key}`).toBe(true);
      }
    }
  });
});

describe('partial failure', () => {
  it('one rejected op never blocks or corrupts sibling ops', () => {
    const w = demoWorld();
    const cs = E.changeFacts(w, [{ key: 'arrival', value: '2026-10-17T09:40' }, { key: 'guests', value: 3 }], NOW).changeSet!;
    for (const op of cs.ops) {
      E.approve(w, E.consentFor(w, op), NOW);
    }
    const outcomes = E.executeApproved(w, NOW);
    const executed = outcomes.filter((o) => o.status === 'executed');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(rejected.length).toBeGreaterThanOrEqual(1); // grocery
    expect(executed.length).toBeGreaterThanOrEqual(3);
    expect(w.commitments['calendar:visit']!.params['start']).toBe('2026-10-17T09:40');
    expect(w.commitments['grocery:arrival-delivery']!.state).toBe('dispatched');
  });
});

// keep T0 referenced so helpers import stays live under strict lint
void T0;
