// Bounded intent parser. Recognizes a small set of utterance shapes and
// maps them to fact edits or queries. Anything unrecognized returns
// { type: 'unknown', examples } and NEVER mutates state.

import type { FactEdit, FactKey, VisitFacts } from './types.js';
import { parseLocal, formatLocal, addDays, humanDay } from './time.js';

export type Intent =
  | { type: 'edit'; edits: FactEdit[]; describe: string }
  | { type: 'recall'; fact: FactKey; describe: string }
  | { type: 'status'; describe: string }
  /** Ambiguous or negated utterance that LOOKS like an edit — we ask rather
   *  than guess. Never mutates state. */
  | { type: 'clarify'; message: string; examples: string[] }
  | { type: 'unknown'; examples: string[] };

export const EXAMPLE_UTTERANCES = [
  'Move arrival to Saturday 9:40',
  'Arrive Friday 18:05',
  'My brother is joining',
  'One more guest',
  '3 guests',
  'Departure Sunday 5pm',
  'Budget $250',
  'What changed because of the flight?',
  'Status',
];

const DAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function nextDayOfWeek(from: number, targetDow: number): number {
  const d = new Date(from);
  const cur = d.getUTCDay();
  let delta = (targetDow - cur + 7) % 7;
  if (delta === 0) delta = 0; // same day stays same day
  return addDays(from, delta);
}

/** Parse "9:40", "09:40", "5pm", "5:30 pm" into minutes since midnight. */
function parseClock(s: string): number | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s.trim());
  if (!m) return null;
  let h = parseInt(m[1]!, 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function minutesToIsoOn(referenceIso: string, minutes: number): string {
  const t = parseLocal(referenceIso)!;
  const base = new Date(t);
  const dayStart = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());
  return formatLocal(dayStart + minutes * 60_000);
}

function dayIsoOn(targetDay: string, referenceT: number, minutes: number): string {
  const dow = DAY_INDEX[targetDay];
  if (dow === undefined) throw new Error(`Unknown day ${targetDay}`);
  const t = nextDayOfWeek(referenceT, dow);
  const d = new Date(t);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return formatLocal(dayStart + minutes * 60_000);
}

// Negation / cancellation words that flip the apparent meaning of an
// edit-shaped utterance. "My brother is NOT joining" must never become +1.
const NEGATION =
  /\b(?:not|n't|never|no longer|without|cancel(?:led|ed|s|ing)?)\b|\bdon'?t\b|\bdont\b|\bdoesn'?t\b|\bwon'?t\b|\bwont\b|\bisn'?t\b|\baren'?t\b|\bcan'?t\b|\bcouldn'?t\b|\bshouldn'?t\b|\bdidn'?t\b|\bwouldn'?t\b/;

const EDIT_SHAPED =
  /brother|sister|friend|partner|join|guest|adult|people|arriv|depart|leav|land|budget|move|change|set|push|\$?\d+/;

export function parseUtterance(raw: string, facts: VisitFacts, _now: number): Intent {
  const text = raw.trim().toLowerCase().replace(/[.!]+$/, '');
  if (!text) return { type: 'unknown', examples: EXAMPLE_UTTERANCES };

  // Negated or cancellation-shaped utterance that resembles an edit:
  // clarify instead of guessing. Checked BEFORE any edit pattern.
  if (NEGATION.test(text) && EDIT_SHAPED.test(text)) {
    return {
      type: 'clarify',
      message:
        "That sounds like a negation or a cancelled plan — nothing was changed. If you meant to update a fact, try one of these:",
      examples: EXAMPLE_UTTERANCES,
    };
  }

  // Malformed numbers must never partial-parse into a plausible edit:
  // "2.5 guests" is not 2 and not 5; "-2 guests" is not 2.
  if (/\d+\.\d+|-\s*\d/.test(text) && EDIT_SHAPED.test(text)) {
    return {
      type: 'clarify',
      message:
        'I can only take whole numbers of guests and whole-dollar budgets — nothing was changed. Try:',
      examples: EXAMPLE_UTTERANCES,
    };
  }

  // ---- recall / status -------------------------------------------------
  if (/what changed|what.*because of|why did|recall/.test(text)) {
    const fact: FactKey = /budget/.test(text)
      ? 'budget'
      : /guest|brother|sister|people|party/.test(text)
        ? 'guests'
        : /depart|leav/.test(text)
          ? 'departure'
          : 'arrival';
    return { type: 'recall', fact, describe: `Recall: changes caused by ${fact}` };
  }
  if (/^(status|summary|what'?s the plan|show plan)$/.test(text)) {
    return { type: 'status', describe: 'Show plan status' };
  }

  // ---- guest count -----------------------------------------------------
  if (/brother|sister|friend|partner|one more|another (adult|guest|person)|joining|joins/.test(text)) {
    // relative references without an action word are ambiguous
    if (/asked|about|wonder|think|maybe|might|if |question|told/.test(text)) {
      return {
        type: 'clarify',
        message: 'I heard you mention someone — but not a clear change. Nothing was altered. Try:',
        examples: EXAMPLE_UTTERANCES,
      };
    }
    const guests = facts.guests + 1;
    return {
      type: 'edit',
      edits: [{ key: 'guests', value: guests }],
      describe: `Guest count ${facts.guests} → ${guests}`,
    };
  }
  let m = /(?<![\d.])(\d+)(?![\d.])\s*(guests?|adults?|people)/.exec(text);
  if (m) {
    const guests = parseInt(m[1]!, 10);
    return {
      type: 'edit',
      edits: [{ key: 'guests', value: guests }],
      describe: `Guest count ${facts.guests} → ${guests}`,
    };
  }

  // ---- budget ----------------------------------------------------------
  m = /budget\s*(?:to|of|=|:)?\s*\$?\s*(\d+)(?![\d.])/.exec(text) ?? /(?<![\d.])\$(\d+)(?![\d.])\s*budget/.exec(text);
  if (m) {
    const budget = parseInt(m[1]!, 10);
    return {
      type: 'edit',
      edits: [{ key: 'budget', value: budget }],
      describe: `Budget $${facts.budget} → $${budget}`,
    };
  }

  // ---- arrival / departure (compound commands must parse BOTH or neither)
  const arrivalEdit = tryArrivalEdit(text, facts);
  const departureEdit = tryDepartureEdit(text, facts);
  const mentionsArrival = /arriv|land/.test(text);
  const mentionsDeparture = /depart|leav/.test(text);
  if (mentionsArrival && mentionsDeparture) {
    if (arrivalEdit !== null && departureEdit !== null) {
      return {
        type: 'edit',
        edits: [arrivalEdit, departureEdit],
        describe: 'Arrival and departure updated together',
      };
    }
    return {
      type: 'clarify',
      message:
        "I heard both an arrival and a departure but couldn't parse both cleanly — nothing was changed. Try one fact at a time, or:",
      examples: EXAMPLE_UTTERANCES,
    };
  }
  if (arrivalEdit !== null) {
    return {
      type: 'edit',
      edits: [arrivalEdit],
      describe: `Arrival → ${humanDay(parseLocal(arrivalEdit.value)!)}`,
    };
  }
  if (departureEdit !== null) {
    return {
      type: 'edit',
      edits: [departureEdit],
      describe: `Departure → ${humanDay(parseLocal(departureEdit.value)!)}`,
    };
  }
  if (mentionsArrival || mentionsDeparture) {
    return {
      type: 'clarify',
      message: 'I heard a travel update but could not parse the date or time — nothing was changed. Try:',
      examples: EXAMPLE_UTTERANCES,
    };
  }

  return { type: 'unknown', examples: EXAMPLE_UTTERANCES };
}

const DAY_NAMES = Object.keys(DAY_INDEX).join('|');
const TIME_RE = `(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)`;

function tryArrivalEdit(text: string, facts: VisitFacts): { key: 'arrival'; value: string } | null {
  let m =
    new RegExp(`(?:move|change|set|push)?\\s*(?:the\\s+)?arrival\\s+(?:to\\s+)?(${DAY_NAMES})\\s*(?:at\\s+)?${TIME_RE}`).exec(text) ??
    new RegExp(`arriv(?:e|al|ing)\\s+(?:on\\s+)?(${DAY_NAMES})\\s*(?:at\\s+)?${TIME_RE}`).exec(text) ??
    new RegExp(`land(?:s|ing)?\\s+(${DAY_NAMES})\\s*(?:at\\s+)?${TIME_RE}`).exec(text);
  if (m) {
    const minutes = parseClock(m[2]!);
    if (minutes !== null) {
      return { key: 'arrival', value: dayIsoOn(m[1]!, parseLocal(facts.arrival)!, minutes) };
    }
    return null;
  }
  // "arrival 9:40" (same day, just time)
  m = new RegExp(`arriv(?:e|al|ing)\\s+(?:at\\s+)?${TIME_RE}$`).exec(text);
  if (m) {
    const minutes = parseClock(m[1]!);
    if (minutes !== null) return { key: 'arrival', value: minutesToIsoOn(facts.arrival, minutes) };
    return null;
  }
  // "earlier"/"later" nudges
  m = /arriv(?:e|al|ing)\s+(\d+)\s*(hour|minute)s?\s+(earlier|later)/.exec(text);
  if (m) {
    const amt = parseInt(m[1]!, 10) * (m[2] === 'hour' ? 60 : 1) * (m[3] === 'earlier' ? -1 : 1);
    return { key: 'arrival', value: formatLocal(parseLocal(facts.arrival)! + amt * 60_000) };
  }
  return null;
}

function tryDepartureEdit(text: string, facts: VisitFacts): { key: 'departure'; value: string } | null {
  const m = new RegExp(
    `(?:depart(?:ure|ing)?|leav(?:e|ing))\\s+(?:on\\s+)?(${DAY_NAMES})\\s*(?:at\\s+)?${TIME_RE}`,
  ).exec(text);
  if (!m) return null;
  const minutes = parseClock(m[2]!);
  if (minutes === null) return null;
  return { key: 'departure', value: dayIsoOn(m[1]!, parseLocal(facts.departure)!, minutes) };
}
