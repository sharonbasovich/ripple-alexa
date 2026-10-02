import type { FactEdit, FactKey, JsonValue, ValidationResult, VisitFacts } from './types.js';
import { parseLocal, formatLocal, addDays } from './time.js';

export const FACT_KEYS: FactKey[] = ['arrival', 'departure', 'guests', 'budget'];

export const MIN_GUESTS = 1;
export const MAX_GUESTS = 8;
export const MAX_BUDGET = 100_000;

/** Fictional fixture: Maya's parents visit Fri–Sun. All prices and policies
 *  anywhere in this repo are synthetic, labelled as such in the UI. */
export const FIXTURE_FACTS: VisitFacts = {
  arrival: '2026-10-16T18:05', // Friday
  departure: '2026-10-18T17:00', // Sunday
  guests: 2,
  budget: 300,
};

/** Simulated "now" for the fixture: Friday 12:00, five hours before the
 *  original arrival — after the grocery dispatch cutoff, inside the
 *  restaurant late-cancel window, on purpose. */
export const FIXTURE_NOW = parseLocal('2026-10-16T12:00')!;

/** When the fixture plan was originally booked — before "now", so service
 *  lifecycles have already advanced (grocery dispatched, rest confirmed). */
export const PLAN_CREATED_AT = parseLocal('2026-10-12T09:00')!;

export function validateFacts(f: VisitFacts): ValidationResult {
  const errors: string[] = [];
  const arr = parseLocal(f.arrival);
  const dep = parseLocal(f.departure);
  if (arr === null) errors.push('Arrival must be a valid date and time (YYYY-MM-DDTHH:MM).');
  if (dep === null) errors.push('Departure must be a valid date and time (YYYY-MM-DDTHH:MM).');
  if (arr !== null && dep !== null && arr >= dep) {
    errors.push('Arrival must be before departure — guests cannot leave before they arrive.');
  }
  if (!Number.isInteger(f.guests)) {
    errors.push('Guest count must be a whole number.');
  } else if (f.guests < MIN_GUESTS || f.guests > MAX_GUESTS) {
    errors.push(`Guest count must be between ${MIN_GUESTS} and ${MAX_GUESTS} adults.`);
  }
  if (!Number.isFinite(f.budget) || !Number.isInteger(f.budget)) {
    errors.push('Budget must be a whole-dollar amount.');
  } else if (f.budget < 0 || f.budget > MAX_BUDGET) {
    errors.push(`Budget must be between $0 and $${MAX_BUDGET.toLocaleString('en-US')}.`);
  }
  return { ok: errors.length === 0, errors };
}

export function validateEdits(facts: VisitFacts, edits: FactEdit[]): ValidationResult {
  const next = applyEdits(facts, edits);
  if (next === null) {
    return { ok: false, errors: ['Unknown fact or malformed value in edit.'] };
  }
  return validateFacts(next);
}

/** Returns the updated facts, or null if an edit key/value is malformed.
 *  Editing arrival NEVER touches departure — a later departure is only
 *  ever changed by an explicit departure edit. */
export function applyEdits(facts: VisitFacts, edits: FactEdit[]): VisitFacts | null {
  const next: VisitFacts = { ...facts };
  for (const e of edits) {
    switch (e.key) {
      case 'arrival':
      case 'departure': {
        if (typeof e.value !== 'string' || parseLocal(e.value) === null) return null;
        next[e.key] = e.value;
        break;
      }
      case 'guests': {
        if (typeof e.value !== 'number' || !Number.isInteger(e.value)) return null;
        next.guests = e.value;
        break;
      }
      case 'budget': {
        if (typeof e.value !== 'number' || !Number.isInteger(e.value)) return null;
        next.budget = e.value;
        break;
      }
      default:
        return null;
    }
  }
  return next;
}

export function editValueFor(key: FactKey, raw: JsonValue): JsonValue {
  void key;
  return raw;
}

/** Convenience for the demo fixture: the scripted change set. */
export function demoChange(facts: VisitFacts): FactEdit[] {
  const arrivalT = parseLocal(facts.arrival)!;
  return [
    { key: 'arrival', value: formatLocal(addDays(arrivalT, 1) + (9 * 60 + 40 - (18 * 60 + 5)) * 60_000) },
    { key: 'guests', value: facts.guests + 1 },
  ];
}
