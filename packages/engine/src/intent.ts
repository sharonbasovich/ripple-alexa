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

  // ---- anchored whole-command edit grammar -------------------------------
  // Every extractor must consume a complete command segment. Whatever is
  // left over is scanned for edit-shaped tokens: if the command still has
  // unparsed meaning we clarify rather than silently applying a partial
  // parse ("3 guests and budget $250" must apply both or neither).
  const covered: [number, number][] = [];
  const edits: FactEdit[] = [];

  const arrival = tryArrivalEdit(text, facts, covered);
  if (arrival) edits.push(arrival);
  const departure = tryDepartureEdit(text, facts, covered);
  if (departure) edits.push(departure);

  const masked = maskCovered(text, covered);

  // guest joins: relative + action verb, whole-phrase match
  let m = /\b(?:my\s+)?(?:brother|sister|friend|partner|mom|dad|mother|father|uncle|aunt|cousin)\b\s*(?:is\s+|will\s+be\s+|may\s+be\s+)?(?:join(?:s|ing)?|coming|staying|tagging along|with us)\b/.exec(masked.text);
  if (!m) {
    m = /\b(?:one more|another)\s+(?:adult|guest|person)\b/.exec(masked.text);
  }
  if (!m) {
    m = /\bjoin(?:s|ing)\b/.exec(masked.text);
  }
  if (m) {
    edits.push({ key: 'guests', value: facts.guests + 1 });
    covered.push([masked.map(m.index), masked.map(m.index + m[0].length)]);
  }

  // explicit guest count
  m = /(?<![\d.])(\d+)(?![\d.])\s*(guests?|adults?|people)/.exec(masked.text);
  if (m) {
    edits.push({ key: 'guests', value: parseInt(m[1]!, 10) });
    covered.push([masked.map(m.index), masked.map(m.index + m[0].length)]);
  }

  // budget
  m = /budget\s*(?:to|of|=|:)?\s*\$?\s*(\d+)(?![\d.])/.exec(masked.text) ??
      /(?<![\d.])\$(\d+)(?![\d.])\s*budget/.exec(masked.text);
  if (m) {
    edits.push({ key: 'budget', value: parseInt(m[1]!, 10) });
    covered.push([masked.map(m.index), masked.map(m.index + m[0].length)]);
  }

  // Coverage check: what remains must contain no edit-shaped tokens.
  const rest = maskCovered(text, covered).text.replace(/[\s,;.!?]+/g, ' ').trim();
  const EDIT_LEFTOVER =
    /brother|sister|friend|partner|mom\b|dad\b|mother|father|uncle|aunt|cousin|guest|adult|people|arriv|depart|leav|land|budget|join|\$|\d|move|change|set |push|earlier|later|hour|minute/;
  if (EDIT_LEFTOVER.test(rest)) {
    return {
      type: 'clarify',
      message:
        edits.length > 0
          ? 'I only understood part of that — nothing was changed. Try one change at a time, or:'
          : 'I heard you mention the visit — but not a clear change. Nothing was altered. Try:',
      examples: EXAMPLE_UTTERANCES,
    };
  }

  if (edits.length > 0) {
    return {
      type: 'edit',
      edits,
      describe: edits
        .map((e) => `${e.key === 'guests' ? 'Guests' : e.key === 'budget' ? 'Budget' : e.key === 'arrival' ? 'Arrival' : 'Departure'} → ${e.key === 'arrival' || e.key === 'departure' ? humanDay(parseLocal(String(e.value))!) : e.value}`)
        .join('; '),
    };
  }

  if (/brother|sister|friend|partner|mom\b|dad\b|mother|father|uncle|aunt|cousin|guest|arriv|depart|leav|land|budget/.test(text)) {
    return {
      type: 'clarify',
      message: 'I heard you mention the visit — but not a clear change. Nothing was altered. Try:',
      examples: EXAMPLE_UTTERANCES,
    };
  }

  return { type: 'unknown', examples: EXAMPLE_UTTERANCES };
}

interface Masked {
  /** Text with covered ranges blanked out. */
  text: string;
  /** Map an index in the masked string back to the original. */
  map: (i: number) => number;
}

function maskCovered(text: string, covered: [number, number][]): Masked {
  const chars = text.split('');
  const mapArr: number[] = [];
  chars.forEach((_, i) => mapArr.push(i));
  for (const [a, b] of covered) {
    for (let i = a; i < b && i < chars.length; i++) chars[i] = ' ';
  }
  return { text: chars.join(''), map: (i) => i };
}

const DAY_NAMES = Object.keys(DAY_INDEX).join('|');
const TIME_RE = `(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)`;

function tryArrivalEdit(
  text: string,
  facts: VisitFacts,
  covered: [number, number][],
): { key: 'arrival'; value: string } | null {
  const patterns = [
    new RegExp(`(?:move|change|set|push)?\\s*(?:the\\s+)?arrival\\s+(?:to\\s+)?(${DAY_NAMES})\\s*(?:at\\s+)?${TIME_RE}`),
    new RegExp(`arriv(?:e|al|ing)\\s+(?:on\\s+)?(${DAY_NAMES})\\s*(?:at\\s+)?${TIME_RE}`),
    new RegExp(`land(?:s|ing)?\\s+(${DAY_NAMES})\\s*(?:at\\s+)?${TIME_RE}`),
    new RegExp(`arriv(?:e|al|ing)\\s+(?:at\\s+)?${TIME_RE}$`),
    /arriv(?:e|al|ing)\s+(\d+)\s*(hour|minute)s?\s+(earlier|later)/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    if (re === patterns[4]) {
      const amt = parseInt(m[1]!, 10) * (m[2] === 'hour' ? 60 : 1) * (m[3] === 'earlier' ? -1 : 1);
      covered.push([m.index, m.index + m[0].length]);
      return { key: 'arrival', value: formatLocal(parseLocal(facts.arrival)! + amt * 60_000) };
    }
    const minutes = parseClock(m[2] ?? m[1]!);
    if (minutes === null) continue;
    const isSameDay = re === patterns[3];
    const iso = isSameDay
      ? minutesToIsoOn(facts.arrival, minutes)
      : dayIsoOn(m[1]!, parseLocal(facts.arrival)!, minutes);
    covered.push([m.index, m.index + m[0].length]);
    return { key: 'arrival', value: iso };
  }
  return null;
}

function tryDepartureEdit(
  text: string,
  facts: VisitFacts,
  covered: [number, number][],
): { key: 'departure'; value: string } | null {
  const m = new RegExp(
    `(?:depart(?:ure|ing)?|leav(?:e|ing))\\s+(?:on\\s+)?(${DAY_NAMES})\\s*(?:at\\s+)?${TIME_RE}`,
  ).exec(text);
  if (!m) return null;
  const minutes = parseClock(m[2]!);
  if (minutes === null) return null;
  covered.push([m.index, m.index + m[0].length]);
  return { key: 'departure', value: dayIsoOn(m[1]!, parseLocal(facts.departure)!, minutes) };
}
