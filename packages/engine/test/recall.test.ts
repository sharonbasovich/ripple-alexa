import { describe, expect, it } from 'vitest';
import * as E from '../src/index.js';
import { demoWorld, NOW, HOUR, approveAndRun } from './helpers.js';

const B = '2026-10-17T09:40';
const C = '2026-10-17T10:40';
function arrival(w: E.World, value: string, now = NOW) {
  const cs = E.changeFacts(w, [{ key: 'arrival', value }], now).changeSet!;
  return cs.ops.find(o => o.commitmentId === 'calendar:visit')!;
}
const calendar = (r: E.CausalRecall) => ({
  history: r.appliedHistory.filter(o => o.commitmentId === 'calendar:visit'),
  pending: r.pendingOperations.filter(o => o.commitmentId === 'calendar:visit'),
});

describe('operation-level causal recall', () => {
  it('retains successful history alongside a newer proposed, approved, then applied update', () => {
    const w = demoWorld();
    const first = arrival(w, B);
    approveAndRun(w, first);
    const next = arrival(w, C);
    let r = calendar(E.recallByFact(w, 'arrival', NOW));
    expect(r.history.map(o => o.patch.start)).toEqual([B]);
    expect(r.pending).toMatchObject([{ id: next.id, state: 'proposed', patch: { start: C }, before: { start: B } }]);
    E.approve(w, E.consentFor(w, next), NOW);
    expect(calendar(E.recallByFact(w, 'arrival', NOW)).pending[0]?.state).toBe('approved');
    E.executeApproved(w, NOW);
    r = calendar(E.recallByFact(w, 'arrival', NOW));
    expect(r.history.map(o => o.patch.start)).toEqual([B, C]);
    expect(r.history.map(o => o.id)).toEqual([first.id, next.id]);
    expect(r.pending).toEqual([]);
    expect(r.history[0]!.executedSeq).toBeLessThan(r.history[1]!.executedSeq);
  });

  it.each(['decline', 'expiry'] as const)('removes %s pending decisions without erasing history', how => {
    const w = demoWorld();
    approveAndRun(w, arrival(w, B));
    const next = arrival(w, C);
    if (how === 'decline') expect(E.decline(w, E.consentFor(w, next), NOW).ok).toBe(true);
    else E.approve(w, E.consentFor(w, next), NOW);
    const clock = how === 'expiry' ? NOW + 12 * HOUR : NOW;
    const before = E.serializeWorld(w);
    const r = calendar(E.recallByFact(w, 'arrival', clock));
    expect(r.pending).toEqual([]);
    expect(r.history.map(o => o.patch.start)).toEqual([B]);
    expect(E.serializeWorld(w)).toBe(before); // expiry read cannot advance or mutate
    if (how === 'expiry') {
      E.advanceTime(w, clock);
      E.repropose(w, clock);
      expect(calendar(E.recallByFact(w, 'arrival', clock)).pending[0]?.state).toBe('proposed');
    }
  });

  it('supersedes old approvals, rechecks with new identities, and preserves budget provenance', () => {
    const w = demoWorld();
    approveAndRun(w, arrival(w, B));
    const old = arrival(w, C);
    E.approve(w, E.consentFor(w, old), NOW);
    E.changeFacts(w, [{ key: 'budget', value: 350 }], NOW + HOUR);
    let r = calendar(E.recallByFact(w, 'arrival', NOW + HOUR));
    expect(r.pending).toHaveLength(1);
    expect(r.pending[0]!.id).not.toBe(old.id);
    expect(r.pending[0]!.changedBy).toContain('arrival');
    expect(r.pending[0]!.changedBy).not.toContain('budget');
    expect(calendar(E.recallByFact(w, 'budget', NOW + HOUR)).pending).toEqual([]);
    const renewed = r.pending[0]!.id;
    E.repropose(w, NOW + HOUR);
    r = calendar(E.recallByFact(w, 'arrival', NOW + HOUR));
    expect(r.pending[0]!.id).not.toBe(renewed);
    expect(r.pending[0]!.state).toBe('proposed');
    expect(r.history.map(o => o.patch.start)).toEqual([B]);
  });

  it('records A to B to A as two operations rather than cancelling history', () => {
    const w = demoWorld();
    const a = w.facts.arrival;
    approveAndRun(w, arrival(w, B));
    approveAndRun(w, arrival(w, a));
    const r = calendar(E.recallByFact(w, 'arrival', NOW));
    expect(r.history.map(o => o.patch.start)).toEqual([B, a]);
    expect(r.history[1]!.before?.start).toBe(B);
    expect(r.history[1]!.after?.start).toBe(a);
  });

  it('keeps cancel and rebook distinct in successful execution order, omitting rejected operations', () => {
    const w = demoWorld();
    const cs = E.changeFacts(w, [{ key: 'arrival', value: B }], NOW).changeSet!;
    for (const o of cs.ops) E.approve(w, E.consentFor(w, o), NOW);
    const outcomes = E.executeApproved(w, NOW);
    const r = E.recallByFact(w, 'arrival', NOW);
    const dinner = r.appliedHistory.filter(o => o.commitmentId === 'restaurant:arrival-dinner');
    expect(dinner.map(o => o.kind)).toEqual(['cancel', 'create']);
    expect(dinner[0]!.after).toBeNull();
    expect(dinner[1]!.before).toBeNull();
    expect(new Set(dinner.map(o => o.id)).size).toBe(2);
    expect(r.appliedHistory.map(o => o.id)).toEqual(w.ledger.filter(e => e.type === 'op.executed')
      .map(e => e.opId).filter(id => cs.ops.some(o => o.id === id && o.changedBy?.includes('arrival'))));
    for (const o of outcomes.filter(o => o.status !== 'executed')) {
      expect(r.appliedHistory.map(h => h.id)).not.toContain(o.opId);
    }
  });

  it('survives replay and reload and returns detached, deterministic snapshots without wall-clock reads', () => {
    const w = demoWorld();
    approveAndRun(w, arrival(w, B));
    arrival(w, C, NOW + HOUR);
    const before = E.serializeWorld(w);
    const r = E.recallByFact(w, 'arrival');
    expect(r).toEqual(E.recallByFact(w, 'arrival', NOW + HOUR));
    expect(r).toEqual(E.recallByFact(E.replay(w.journal), 'arrival'));
    expect(r).toEqual(E.recallByFact(E.deserializeWorld(before)!, 'arrival'));
    r.appliedHistory[0]!.patch.start = 'mutated';
    r.pendingOperations[0]!.changedBy.push('budget');
    expect(E.serializeWorld(w)).toBe(before);
    expect(E.recallByFact(w, 'arrival').appliedHistory[0]!.patch.start).not.toBe('mutated');
  });
});
