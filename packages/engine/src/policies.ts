// Fictional service policies. Every price, fee and window below is synthetic
// demo data — labelled as such wherever shown to a user.

import type {
  Commitment,
  JsonValue,
  LifecycleState,
  PolicyDecision,
  ServiceId,
  ServicePolicy,
} from './types.js';
import { parseLocal, addMinutes, sameDay } from './time.js';

const HOUR = 3_600_000;

function paramTime(c: Commitment, key: string): number | null {
  const v = c.params[key];
  return typeof v === 'string' ? parseLocal(v) : null;
}

function numeric(c: Commitment, key: string): number {
  const v = c.params[key];
  return typeof v === 'number' ? v : 0;
}

function simplePolicy(
  service: ServiceId,
  opts: {
    updateable?: (c: Commitment, patch: Record<string, JsonValue>, now: number) => PolicyDecision;
    cancellable?: (c: Commitment, now: number) => PolicyDecision;
    fee?: (c: Commitment, now: number) => number;
    next?: (c: Commitment, now: number) => { to: LifecycleState; at: number } | null;
  },
): ServicePolicy {
  return {
    service,
    canCancel: (c, now) => {
      if (c.state === 'cancelled' || c.state === 'completed') {
        return { allowed: false, reason: `Already ${c.state}.` };
      }
      if (opts.cancellable) return opts.cancellable(c, now);
      return { allowed: true };
    },
    canUpdate: (c, patch, now) => {
      if (c.state === 'cancelled' || c.state === 'completed') {
        return { allowed: false, reason: `Already ${c.state}.` };
      }
      if (opts.updateable) return opts.updateable(c, patch, now);
      if (c.state === 'dispatched') {
        return { allowed: false, reason: 'Already dispatched — changes are no longer accepted.' };
      }
      return { allowed: true };
    },
    cancelFee: (c, now) => (opts.fee ? opts.fee(c, now) : 0),
    nextTransition: (c, now) => (opts.next ? opts.next(c, now) : null),
  };
}

/** Standard pending→confirmed ramp: the service confirms `hours` after the
 *  commitment was booked (createdAt), never relative to the caller's now. */
function confirmAfter(hours: number) {
  return (c: Commitment, _now: number) => {
    if (c.state === 'pending') {
      return { to: 'confirmed' as LifecycleState, at: c.createdAt + hours * HOUR };
    }
    return null;
  };
}

export const POLICIES: Record<ServiceId, ServicePolicy> = {
  calendar: simplePolicy('calendar', { next: confirmAfter(0.1) }),

  pickup: simplePolicy('pickup', {
    next: (c, now) => {
      if (c.state === 'pending') return { to: 'confirmed', at: c.createdAt + 0.5 * HOUR };
      const fireAt = paramTime(c, 'remindAt');
      if (c.state === 'confirmed' && fireAt !== null && now >= fireAt) {
        return { to: 'completed', at: now };
      }
      return null;
    },
  }),

  routines: simplePolicy('routines', {
    next: (c, now) => {
      if (c.state === 'pending') return { to: 'confirmed', at: c.createdAt + 0.25 * HOUR };
      const runAt = paramTime(c, 'runAt');
      if (c.state === 'confirmed' && runAt !== null && now >= runAt) {
        return { to: 'completed', at: now };
      }
      return null;
    },
  }),

  // Fictional grocery policy: free reschedule while pending/confirmed;
  // dispatches 8h before the delivery window opens; once dispatched the
  // order cannot be cancelled or rescheduled and must be accepted as-is.
  grocery: simplePolicy('grocery', {
    updateable: (c, _patch, _now) => {
      if (c.state === 'dispatched') {
        return {
          allowed: false,
          reason:
            'Delivery already dispatched — this order can no longer be changed or cancelled.',
        };
      }
      return { allowed: true };
    },
    cancellable: (c, _now) => {
      if (c.state === 'dispatched') {
        return {
          allowed: false,
          reason:
            'Delivery already dispatched — this order can no longer be changed or cancelled.',
        };
      }
      return { allowed: true };
    },
    next: (c, _now) => {
      if (c.state === 'pending') return { to: 'confirmed', at: c.createdAt + 1 * HOUR };
      const windowStart = paramTime(c, 'windowStart');
      if (c.state === 'confirmed' && windowStart !== null) {
        return { to: 'dispatched', at: windowStart - 8 * HOUR };
      }
      const windowEnd = paramTime(c, 'windowEnd');
      if (c.state === 'dispatched' && windowEnd !== null) {
        return { to: 'completed', at: windowEnd };
      }
      return null;
    },
  }),

  // Fictional restaurant policy: bookings may only be edited within the same
  // day; a move to another day requires cancel + rebook. Cancelling inside
  // 24h of the booking costs a flat $25 per seat, disclosed before consent.
  restaurant: simplePolicy('restaurant', {
    updateable: (c, patch, now) => {
      const cur = paramTime(c, 'time');
      const nxt = typeof patch['time'] === 'string' ? parseLocal(patch['time']) : null;
      if (cur !== null && nxt !== null && !sameDay(cur, nxt)) {
        return {
          allowed: false,
          reason:
            'This restaurant only allows same-day edits — a different day requires cancelling and rebooking.',
        };
      }
      void now;
      return { allowed: true };
    },
    fee: (c, now) => {
      const t = paramTime(c, 'time');
      if (t === null) return 0;
      const hoursToBooking = (t - now) / HOUR;
      if (hoursToBooking < 24) return 25 * Math.max(1, numeric(c, 'partySize'));
      return 0;
    },
    next: (c, now) => {
      if (c.state === 'pending') return { to: 'confirmed', at: c.createdAt + 2 * HOUR };
      const t = paramTime(c, 'time');
      if (c.state === 'confirmed' && t !== null && now >= addMinutes(t, 120)) {
        return { to: 'completed', at: now };
      }
      return null;
    },
  }),
};
