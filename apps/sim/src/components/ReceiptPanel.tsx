import { useState } from 'react';
import * as E from '@ripple/engine';
import type { LedgerEvent, World } from '@ripple/engine';

const EVENT_LABEL: Record<string, string> = {
  'plan.created': 'Plan created',
  'facts.changed': 'Facts changed',
  'changeset.proposed': 'Decisions proposed',
  'op.approved': 'Approved',
  'op.declined': 'Declined',
  'op.expired': 'Decision expired',
  'changeset.expired': 'Decision window expired',
  'changeset.superseded': 'Superseded by newer change',
  'op.executed': 'Applied',
  'op.rejected': 'Rejected at execution',
  'op.requoted': 'Price changed — fresh decision required',
  'fee.charged': 'Fee charged',
  'service.transition': 'Service updated',
  'service.stale_event': 'Stale async event ignored',
  kept_by_choice: 'Kept — earlier decline honoured',
  'budget.evaluated': 'Budget check',
};

function eventDetail(e: LedgerEvent): string {
  const p = e.payload;
  const label = typeof p['label'] === 'string' ? p['label'] : '';
  const bits: string[] = [label];
  if (typeof p['from'] === 'string' && typeof p['to'] === 'string' && p['from'] !== p['to']) {
    bits.push(`${p['from']} → ${p['to']}`);
  }
  if (typeof p['amount'] === 'number') bits.push(`$${p['amount']}`);
  if (typeof p['reason'] === 'string') bits.push(p['reason']);
  if (typeof p['feasible'] === 'boolean') {
    bits.push(p['feasible'] ? 'within budget' : 'over budget');
  }
  return bits.filter(Boolean).join(' · ');
}

export function ReceiptPanel({ world }: { world: World }) {
  const [open, setOpen] = useState(false);
  const receipts = E.FACT_KEYS.map((f) => E.receiptsForFact(world, f)).filter(
    (r) => r.events.length > 0,
  );
  const events = [...world.ledger].reverse();

  return (
    <section className="receipts" aria-label="Causal receipt">
      <button className="receipts-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        Causal receipt — {world.ledger.length} recorded events {open ? '▲' : '▼'}
      </button>
      {open && (
        <div className="receipts-body">
          <div className="receipt-by-fact">
            {receipts.map((r) => (
              <div key={r.fact} className="receipt-fact">
                <h4>
                  Because <strong>{r.fact}</strong> changed:
                </h4>
                <ul>
                  {r.ops.map((o) => (
                    <li key={o.id}>
                      <span className={`rc-dot ${o.status}`} />
                      {o.label}
                      {o.fee ? <span className="fee"> · ${o.fee} fee</span> : null}
                      {o.costDelta ? (
                        <span className="cost">
                          {' '}
                          · {o.costDelta > 0 ? '+' : ''}${o.costDelta} cost
                        </span>
                      ) : null}
                      <em className="status"> {o.status.replace(/_/g, ' ')}</em>
                    </li>
                  ))}
                  {r.ops.length === 0 && <li className="muted">No ops (notification only).</li>}
                </ul>
              </div>
            ))}
            {receipts.length === 0 && <p className="muted">Nothing has changed yet.</p>}
          </div>
          <ol className="ledger">
            {events.slice(0, 60).map((e) => (
              <li key={e.seq}>
                <span className="seq">#{e.seq}</span> {EVENT_LABEL[e.type] ?? e.type}
                {eventDetail(e) ? ` — ${eventDetail(e)}` : ''}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
