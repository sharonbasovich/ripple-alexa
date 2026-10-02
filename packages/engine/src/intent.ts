// Bounded intent parser. Recognizes a small set of utterance shapes and
// maps them to fact edits or queries. Anything unrecognized returns
// { type: 'unknown', examples } and NEVER mutates state.

import type { FactEdit, FactKey, VisitFacts } from './types.js';
import { parseLocal, formatLocal, addDays, humanDay } from './time.js';

export type Intent =
  | { type: 'edit'; edits: FactEdit[]; describe: string }
  | { type: 'recall'; fact: FactKey; describe: string }
  | { type: 'status'; describe: string }
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

export function parseUtterance(raw: string, facts: VisitFacts, _now: number): Intent {
  const text = raw.trim().toLowerCase().replace(/[.!]+$/, '');
  if (!text) return { type: 'unknown', examples: EXAMPLE_UTTERANCES };

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
    const guests = facts.guests + 1;
    return {
      type: 'edit',
      edits: [{ key: 'guests', value: guests }],
      describe: `Guest count ${facts.guests} → ${guests}`,
    };
  }
  let m = /(\d+)\s*(guests?|adults?|people)/.exec(text);
  if (m) {
    const guests = parseInt(m[1]!, 10);
    return {
      type: 'edit',
      edits: [{ key: 'guests', value: guests }],
      describe: `Guest count ${facts.guests} → ${guests}`,
    };
  }

  // ---- budget ----------------------------------------------------------
  m = /budget\s*(?:to|of|=|:)?\s*\$?\s*(\d+)/.exec(text) ?? /\$(\d+)\s*budget/.exec(text);
  if (m) {
    const budget = parseInt(m[1]!, 10);
    return {
      type: 'edit',
      edits: [{ key: 'budget', value: budget }],
      describe: `Budget $${facts.budget} → $${budget}`,
    };
  }

  // ---- arrival / departure ---------------------------------------------
  const dayNames = Object.keys(DAY_INDEX).join('|');
  const timeRe = `(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)`;

  // "move arrival to saturday 9:40" / "arrive saturday 9:40" / "arrival sat 9:40"
  m = new RegExp(`(?:move|change|set|push)?\\s*(?:the\\s+)?arrival\\s+(?:to\\s+)?(${dayNames})\\s*(?:at\\s+)?${timeRe}`).exec(text)
    ?? new RegExp(`arriv(?:e|al|ing)\\s+(?:on\\s+)?(${dayNames})\\s*(?:at\\s+)?${timeRe}`).exec(text)
    ?? new RegExp(`land(?:s|ing)?\\s+(${dayNames})\\s*(?:at\\s+)?${timeRe}`).exec(text);
  if (m) {
    const minutes = parseClock(m[2]!);
    if (minutes !== null) {
      const ref = parseLocal(facts.arrival)!;
      const iso = dayIsoOn(m[1]!, ref, minutes);
      return {
        type: 'edit',
        edits: [{ key: 'arrival', value: iso }],
        describe: `Arrival → ${humanDay(parseLocal(iso)!)} ${m[2]}`,
      };
    }
  }

  // "arrival 9:40" (same day, just time)
  m = new RegExp(`arriv(?:e|al|ing)\\s+(?:at\\s+)?${timeRe}$`).exec(text);
  if (m) {
    const minutes = parseClock(m[1]!);
    if (minutes !== null) {
      const iso = minutesToIsoOn(facts.arrival, minutes);
      return {
        type: 'edit',
        edits: [{ key: 'arrival', value: iso }],
        describe: `Arrival → ${m[1]!} same day`,
      };
    }
  }

  // "departure sunday 5pm" / "leave sunday at 5pm" / "leaving sunday 17:00"
  m = new RegExp(`(?:depart(?:ure|ing)?|leav(?:e|ing))\\s+(?:on\\s+)?(${dayNames})\\s*(?:at\\s+)?${timeRe}`).exec(text);
  if (m) {
    const minutes = parseClock(m[2]!);
    if (minutes !== null) {
      const ref = parseLocal(facts.departure)!;
      const iso = dayIsoOn(m[1]!, ref, minutes);
      return {
        type: 'edit',
        edits: [{ key: 'departure', value: iso }],
        describe: `Departure → ${humanDay(parseLocal(iso)!)} ${m[2]!}`,
      };
    }
  }

  // "earlier"/"later" nudges
  m = /arriv(?:e|al|ing)\s+(\d+)\s*(hour|minute)s?\s+(earlier|later)/.exec(text);
  if (m) {
    const amt = parseInt(m[1]!, 10) * (m[2] === 'hour' ? 60 : 1) * (m[3] === 'earlier' ? -1 : 1);
    const iso = formatLocal(parseLocal(facts.arrival)! + amt * 60_000);
    return {
      type: 'edit',
      edits: [{ key: 'arrival', value: iso }],
      describe: `Arrival ${amt > 0 ? '+' : ''}${amt} minutes`,
    };
  }

  return { type: 'unknown', examples: EXAMPLE_UTTERANCES };
}
