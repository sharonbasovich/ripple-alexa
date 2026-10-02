import * as E from '../src/index.js';
import type { World, Op, Consent } from '../src/index.js';

export const T0 = E.PLAN_CREATED_AT;
export const NOW = E.FIXTURE_NOW;
export const HOUR = 3_600_000;

/** Fixture world: plan booked Monday, observed Friday 12:00 — grocery
 *  already dispatched, everything else confirmed. */
export function demoWorld(now: number = NOW): World {
  const w = E.createWorld(E.FIXTURE_FACTS, T0);
  E.advanceTime(w, now);
  return w;
}

export const DEMO_ARRIVAL = '2026-10-17T09:40'; // Saturday

export function demoEdits(): E.FactEdit[] {
  return [
    { key: 'arrival', value: DEMO_ARRIVAL },
    { key: 'guests', value: 3 },
  ];
}

export function propose(w: World, now: number = NOW): E.ChangeSet {
  const r = E.changeFacts(w, demoEdits(), now);
  if (!r.ok || !r.changeSet) throw new Error(`changeFacts failed: ${r.errors}`);
  return r.changeSet;
}

export function consent(w: World, op: Op): Consent {
  return E.consentFor(w, op);
}

export function opFor(w: World, commitmentId: string, kind?: string): Op {
  const cs = E.openChangeSet(w, NOW);
  const op = cs?.ops.find(
    (o) => o.commitmentId === commitmentId && (!kind || o.kind === kind),
  );
  if (!op) throw new Error(`No op for ${commitmentId}${kind ? ` (${kind})` : ''}`);
  return op;
}

/** Approve + execute a specific op. */
export function approveAndRun(w: World, op: Op, now: number = NOW) {
  const a = E.approve(w, consent(w, op), now);
  if (!a.ok) throw new Error(`approve failed: ${a.message}`);
  return E.executeApproved(w, now);
}

/** mulberry32 — tiny deterministic PRNG for property tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
