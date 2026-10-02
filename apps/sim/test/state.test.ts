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
});

describe('previewEdits', () => {
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
