import type { JsonValue } from './types.js';

/** Canonical JSON: sorted object keys, no whitespace. Deterministic for hashing. */
export function canonical(v: JsonValue | undefined): string {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, JsonValue>)[k])}`).join(',')}}`;
}

/** FNV-1a 32-bit, hex. Stable across runs — used for deterministic ids. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function hashParts(...parts: (JsonValue | undefined)[]): string {
  return fnv1a(parts.map(canonical).join('|'));
}
