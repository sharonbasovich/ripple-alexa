import * as E from '@ripple/engine';
import type { World } from '@ripple/engine';
import { fmtParamValue, paramLabel } from '../state';

const SERVICE_ORDER: E.ServiceId[] = ['calendar', 'grocery', 'restaurant', 'routines', 'pickup'];

const SERVICE_META: Record<E.ServiceId, { label: string; blurb: string }> = {
  calendar: { label: 'Calendar', blurb: 'fictional calendar' },
  grocery: { label: 'Grocery delivery', blurb: 'fictional delivery windows' },
  restaurant: { label: 'Restaurant', blurb: 'fictional reservations' },
  routines: { label: 'Routines', blurb: 'fictional home routines' },
  pickup: { label: 'Pickup reminders', blurb: 'fictional reminders' },
};

const STATE_CLS: Record<string, string> = {
  pending: 'st-pending',
  confirmed: 'st-confirmed',
  dispatched: 'st-dispatched',
  completed: 'st-completed',
  cancelled: 'st-cancelled',
};

export function PlanBoard({
  world,
  affectedIds,
}: {
  world: World;
  affectedIds: Set<string>;
}) {
  const byService = new Map<E.ServiceId, E.Commitment[]>();
  for (const s of SERVICE_ORDER) byService.set(s, []);
  for (const c of Object.values(world.commitments)) byService.get(c.service)?.push(c);

  return (
    <div className="board" role="list" aria-label="Commitments by service">
      {SERVICE_ORDER.map((sid) => {
        const items = (byService.get(sid) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
        if (!items.length) return null;
        return (
          <section key={sid} className={`svc svc-${sid}`} aria-label={SERVICE_META[sid].label}>
            <h4>{SERVICE_META[sid].label}</h4>
            <p className="svc-sub">{SERVICE_META[sid].blurb}</p>
            {items.map((c) => (
              <div
                key={c.id}
                role="listitem"
                className={`commit ${STATE_CLS[c.state] ?? ''} ${affectedIds.has(c.id) ? 'affected' : ''}`}
              >
                <div className="commit-head">
                  <span className="state-badge">{c.state}</span>
                  <strong>{c.label}</strong>
                  <span className="cost">${c.cost}</span>
                </div>
                <dl className="params">
                  {Object.entries(c.params).map(([k, v]) => (
                    <div key={k}>
                      <dt>{paramLabel(k)}</dt>
                      <dd>{fmtParamValue(v)}</dd>
                    </div>
                  ))}
                </dl>
                {c.state === 'dispatched' && (
                  <p className="policy-note">Dispatched — policy forbids reschedule/cancel.</p>
                )}
                {c.state === 'cancelled' && (
                  <p className="policy-note">Cancelled — original terms forfeit.</p>
                )}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
