import { describe, it, expect, beforeEach } from 'vitest';
import * as E from '@ripple/engine';
import {
  seed,
  load,
  persist,
  clearPersisted,
  previewEdits,
  runUtterance,
  speakableSummary,
  fmtParamValue,
} from '../src/state';

// minimal localStorage stub — node env has none
const store = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageStub, writable: true });


beforeEach(() => {
  store.clear();
});

describe('seed', () => {
  it('creates fixture world with grocery already dispatched at fixture-now', () => {
    const s = seed();
    expect(s.now).toBe(E.FIXTURE_NOW);
    expect(s.world.facts.guests).toBe(2);
    expect(s.world.commitments['grocery:arrival-delivery']!.state).toBe('dispatched');
    expect(Object.keys(s.world.commitments)).toHaveLength(7);
  });
});

describe('persistence', () => {
  it('round-trips world + clock through localStorage', () => {
    const s = seed();
    E.changeFacts(s.world, [{ key: 'guests', value: 3 }], s.now);
    persist(s);
    const back = load();
    expect(back).not.toBeNull();
    expect(back!.now).toBe(s.now);
    expect(E.stateEquals(back!.world, s.world)).toBe(true);
  });

  it('returns null on corrupt or missing data', () => {
    expect(load()).toBeNull();
    store.set('ripple:v1', 'not json');
    expect(load()).toBeNull();
    store.set('ripple:v1', JSON.stringify({ now: 'x', world: 4 }));
    expect(load()).toBeNull();
  });

  it('clearPersisted removes state', () => {
    persist(seed());
    clearPersisted();
    expect(load()).toBeNull();
  });

  it.each([1e100, -1, 0, 1.5])('rejects an invalid or inconsistent saved clock %s', (now) => {
    const s = seed();
    store.set('ripple:v1', JSON.stringify({ now, world: E.serializeWorld(s.world) }));
    expect(load()).toBeNull();
  });

  it('rejects a clock ahead of the journal instead of skipping lifecycle transitions', () => {
    const s = seed();
    store.set('ripple:v1', JSON.stringify({ now: s.now + 24 * 60 * 60_000, world: E.serializeWorld(s.world) }));
    expect(load()).toBeNull();
  });
});

describe('previewEdits', () => {
  it('does not promise unresolved arrival repairs stay booked on a budget-only follow-up', () => {
    const s = seed();
    E.changeFacts(s.world, [{ key: 'arrival', value: '2026-10-17T09:40' }], s.now);
    const before = E.serializeWorld(s.world);
    const edits: E.FactEdit[] = [{ key: 'budget', value: 250 }];
    const p = previewEdits(s.world, edits, s.now);
    expect(E.serializeWorld(s.world)).toBe(before);
    const projected = structuredClone(s.world);
    const actual = E.changeFacts(projected, edits, s.now).changeSet!;
    const actualIds = new Set(actual.ops.map(op => op.commitmentId));
    expect(actualIds.size).toBe(6);
    expect(p.untouched.filter(c => actualIds.has(c.id))).toEqual([]);
    expect(p.affected).toEqual([]);
    expect(p.carriedForward).toHaveLength(6);
    expect(p.untouched.map(c => c.id)).toEqual(['routines:farewell']);
  });

  it.each([
    ['budget', 'pending'], ['budget', 'approved'], ['budget', 'declined'], ['budget', 'expired'],
    ['guests', 'pending'], ['guests', 'approved'], ['guests', 'declined'], ['guests', 'expired'],
  ] as const)('matches actual whole-plan proposals for %s after %s arrival decisions', (fact, status) => {
    const s = seed();
    const prior = E.changeFacts(s.world, [{ key: 'arrival', value: '2026-10-17T09:40' }], s.now).changeSet!;
    const cancellation = prior.ops.find(op => op.kind === 'cancel' && op.fee === 75)!;
    const oldConsent = E.consentFor(s.world, cancellation);
    if (status === 'approved') expect(E.approve(s.world, oldConsent, s.now).ok).toBe(true);
    if (status === 'declined') for (const op of prior.ops) E.decline(s.world, E.consentFor(s.world, op), s.now);
    if (status === 'expired') { s.now += E.CHANGESET_TTL_MS; E.advanceTime(s.world, s.now); }
    const before = E.serializeWorld(s.world);
    const edits: E.FactEdit[] = [fact === 'budget' ? { key: 'budget', value: 250 } : { key: 'guests', value: 3 }];
    const p = previewEdits(s.world, edits, s.now);
    expect(E.serializeWorld(s.world)).toBe(before);
    expect(p.errors).toEqual([]);
    expect(p.affected).toHaveLength(fact === 'budget' ? 0 : 5);
    expect(p.carriedForward.map(c => c.id)).toEqual(fact === 'budget'
      ? ['calendar:visit', 'grocery:arrival-delivery', 'restaurant:arrival-dinner', 'routines:welcome', 'routines:coffee', 'pickup:airport']
      : ['pickup:airport']);
    expect(p.untouched.map(c => c.id)).toEqual(['routines:farewell']);
    expect(p.notes.join(' ')).toContain('replaces any open decisions and approvals');
    expect(p.notes.join(' ')).toContain('declined or expired choices');

    const projected = structuredClone(s.world);
    const cs = E.changeFacts(projected, edits, s.now).changeSet!;
    expect([...new Set(cs.ops.map(op => op.commitmentId))].sort())
      .toEqual([...p.affected, ...p.carriedForward].map(c => c.id).sort());
    expect(projected.commitments).toEqual(s.world.commitments);
    expect(projected.feesCharged).toBe(0);
    expect(cs.ops.every(op => op.status === 'proposed')).toBe(true);
    expect(cs.ops.every(op => !prior.ops.some(old => old.id === op.id))).toBe(true);
    if (status === 'approved') {
      expect(E.approve(projected, oldConsent, s.now)).toMatchObject({ ok: false, reason: 'stale' });
      expect(E.executeApproved(projected, s.now)).toEqual([]);
      const freshCancellation = cs.ops.find(op => op.kind === 'cancel')!;
      expect(E.approve(projected, E.consentFor(projected, freshCancellation), s.now).ok).toBe(true);
      E.executeApproved(projected, s.now);
      expect(projected.feesCharged).toBe(75);
      E.executeApproved(projected, s.now);
      expect(projected.feesCharged).toBe(75);
    }
  });

  it('keeps unresolved decisions intact for a no-op instead of promising every booking matches', () => {
    const s = seed();
    E.changeFacts(s.world, [{ key: 'arrival', value: '2026-10-17T09:40' }], s.now);
    const before = E.serializeWorld(s.world);
    const edits: E.FactEdit[] = [{ key: 'budget', value: s.world.facts.budget }];
    const p = previewEdits(s.world, edits, s.now);
    expect(p.affected).toEqual([]);
    expect(p.carriedForward).toEqual([]);
    expect(p.untouched).toEqual([]);
    expect(p.notes.join(' ')).toContain('Existing decisions stay as they are');
    expect(E.changeFacts(s.world, edits, s.now).noOp).toBe(true);
    expect(E.serializeWorld(s.world)).toBe(before);
  });

  it('previews an orphan with an inconsistent map key accepted by the saved-world loader', () => {
    const s = seed();
    s.world.commitments['renamed-map-key'] = { ...s.world.commitments['calendar:visit']!, id: 'orphan-id' };
    const restored = E.deserializeWorld(E.serializeWorld(s.world));
    expect(restored).not.toBeNull();
    const before = E.serializeWorld(restored!);
    const edits: E.FactEdit[] = [{ key: 'budget', value: 250 }];
    const p = previewEdits(restored!, edits, s.now);
    expect(p.carriedForward).toEqual([{ id: 'orphan-id', label: 'Family visit', service: 'calendar' }]);
    expect(E.serializeWorld(restored!)).toBe(before);
    const actual = E.changeFacts(structuredClone(restored!), edits, s.now).changeSet!;
    expect(actual.ops.map(op => op.commitmentId)).toEqual(p.carriedForward.map(c => c.id));
  });

  it('carries only outstanding repairs after a paid cancellation and never duplicates the fee', () => {
    const s = seed();
    const first = E.changeFacts(s.world, [{ key: 'arrival', value: '2026-10-17T09:40' }], s.now).changeSet!;
    const cancellation = first.ops.find(op => op.kind === 'cancel')!;
    E.approve(s.world, E.consentFor(s.world, cancellation), s.now);
    E.executeApproved(s.world, s.now);
    const before = E.serializeWorld(s.world);
    const edits: E.FactEdit[] = [{ key: 'budget', value: 250 }];
    const p = previewEdits(s.world, edits, s.now);
    expect(E.serializeWorld(s.world)).toBe(before);
    expect(p.affected).toEqual([]);
    expect(p.carriedForward.some(c => c.id === 'restaurant:arrival-dinner')).toBe(true);
    const cs = E.changeFacts(s.world, edits, s.now).changeSet!;
    expect(s.world.feesCharged).toBe(75);
    expect(cs.ops.some(op => op.kind === 'cancel')).toBe(false);
    const rebook = cs.ops.find(op => op.kind === 'create' && op.commitmentId === cancellation.commitmentId)!;
    E.approve(s.world, E.consentFor(s.world, rebook), s.now);
    E.executeApproved(s.world, s.now);
    expect(s.world.feesCharged).toBe(75);
  });

  it('reports deltas, affected vs untouched commitments, departure note', () => {
    const s = seed();
    const p = previewEdits(s.world, [
      { key: 'arrival', value: '2026-10-17T09:40' },
      { key: 'guests', value: 3 },
    ]);
    expect(p.errors).toHaveLength(0);
    expect(p.deltas.map((d) => d.key).sort()).toEqual(['arrival', 'guests']);
    // arrival+guests affect grocery, restaurant, pickup, calendar, welcome, coffee
    expect(p.affected.length).toBeGreaterThanOrEqual(5);
    // farewell depends on departure only → untouched
    expect(p.untouched.map((u) => u.id)).toContain('routines:farewell');
    expect(p.notes.some((n) => /departure stays/i.test(n))).toBe(true);
    // nothing mutated by preview
    const v0 = s.world.factsVersion;
    previewEdits(s.world, [{ key: 'budget', value: 100 }]);
    expect(s.world.facts.arrival).toBe(E.FIXTURE_FACTS.arrival);
    expect(s.world.factsVersion).toBe(v0);
  });

  it('invalid edits produce errors and no deltas', () => {
    const s = seed();
    const p = previewEdits(s.world, [{ key: 'arrival', value: '2026-10-20T09:40' }]);
    expect(p.errors.length).toBeGreaterThan(0); // arrival after departure
    const p2 = previewEdits(s.world, [{ key: 'guests', value: 99 }]);
    expect(p2.errors.length).toBeGreaterThan(0);
    const p3 = previewEdits(s.world, [{ key: 'budget', value: -5 }]);
    expect(p3.errors.length).toBeGreaterThan(0);
  });

  it('no-op edits say nothing changes', () => {
    const s = seed();
    const p = previewEdits(s.world, [{ key: 'guests', value: 2 }]);
    expect(p.deltas).toHaveLength(0);
    expect(p.notes.some((n) => /no fact/i.test(n))).toBe(true);
  });
});

describe('runUtterance', () => {
  it('parses supported intents and returns examples for unknown text', () => {
    const s = seed();
    const edit = runUtterance(s.world, 'Move arrival to Saturday 9:40', s.now);
    expect(edit.type).toBe('edit');
    const guests = runUtterance(s.world, 'My brother is joining', s.now);
    expect(guests.type).toBe('edit');
    const recall = runUtterance(s.world, 'What changed because of the flight?', s.now);
    expect(recall.type).toBe('recall');
    const unk = runUtterance(s.world, 'Order me a pizza', s.now);
    expect(unk.type).toBe('unknown');
    if (unk.type === 'unknown') expect(unk.examples.length).toBeGreaterThan(0);
  });
});

describe('speakableSummary', () => {
  it('stays under 75 words and contains no ids or markdown', () => {
    const s = seed();
    E.changeFacts(
      s.world,
      [
        { key: 'arrival', value: '2026-10-17T09:40' },
        { key: 'guests', value: 3 },
      ],
      s.now,
    );
    const text = speakableSummary(s.world, s.now);
    expect(text.split(/\s+/).length).toBeLessThan(75);
    expect(text).not.toMatch(/[#*`]/);
    expect(text).not.toMatch(/[a-f0-9]{8,}/i); // no hashed ids
  });
});

describe('fmtParamValue', () => {
  it('renders datetime params as human times, others verbatim', () => {
    expect(fmtParamValue('2026-10-16T18:05')).toContain('Friday');
    expect(fmtParamValue(3)).toBe('3');
  });
});

describe('exact-date validation preview and recovery', () => {
  it('shows an invalid interpretation and offers only a valid upcoming previous-week preview', () => {
    const s = seed();
    E.changeFacts(s.world, [{ key: 'arrival', value: '2026-10-17T09:40' }], s.now);
    const original = E.serializeWorld(s.world);
    const p = previewEdits(s.world, [{ key: 'arrival', value: '2026-10-23T18:05' }], s.now);
    expect(p.errors).toHaveLength(1);
    expect(p.deltas[0]?.after).toBe('Friday 2026-10-23 18:05');
    expect(p.notes.join(' ')).toContain('Departure stays Sunday 2026-10-18 17:00');
    expect(p.recovery?.edits).toEqual([{ key: 'arrival', value: '2026-10-16T18:05' }]);
    const corrected = previewEdits(s.world, p.recovery!.edits, s.now);
    expect(corrected.errors).toHaveLength(0);
    expect(corrected.notes.join(' ')).not.toContain('gets shorter');
    expect(E.serializeWorld(s.world)).toBe(original);
  });

  it('never offers a past or still-invalid correction, or alters a compound date request', () => {
    const s = seed();
    E.changeFacts(s.world, [{ key: 'arrival', value: '2026-10-17T09:40' }], s.now);
    expect(previewEdits(s.world, [{ key: 'arrival', value: '2026-10-19T09:40' }], s.now).recovery).toBeUndefined();
    expect(previewEdits(s.world, [{ key: 'arrival', value: '2026-10-23T18:05' }], E.parseLocal('2026-10-16T19:00')!).recovery).toBeUndefined();
    expect(previewEdits(s.world, [
      { key: 'arrival', value: '2026-10-23T18:05' }, { key: 'guests', value: 99 },
    ], s.now).recovery).toBeUndefined();
    expect(previewEdits(s.world, [
      { key: 'arrival', value: '2026-10-23T18:05' }, { key: 'departure', value: '2026-10-19T08:00' },
    ], s.now).recovery).toBeUndefined();
    expect(previewEdits(s.world, [
      { key: 'arrival', value: '2026-10-23T18:05' }, { key: 'departure', value: E.FIXTURE_FACTS.departure },
    ], s.now).recovery).toBeUndefined();
  });

  it('explains unchanged arrival for an invalid departure-only change', () => {
    const s = seed();
    const p = previewEdits(s.world, [{ key: 'departure', value: '2026-10-15T17:00' }], s.now);
    expect(p.errors.length).toBeGreaterThan(0);
    expect(p.deltas[0]?.after).toBe('Thursday 2026-10-15 17:00');
    expect(p.notes.join(' ')).toContain('Arrival stays Friday 2026-10-16 18:05');
    expect(p.recovery).toBeUndefined();
  });
});
