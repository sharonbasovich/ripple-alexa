import * as E from '@ripple/engine';
import type { ChangeSet, Op } from '@ripple/engine';
import { describeOp, fmtParamValue } from '../state';

const KIND_BADGE: Record<string, { label: string; cls: string }> = {
  create: { label: 'New booking', cls: 'kind-create' },
  update: { label: 'Change', cls: 'kind-update' },
  cancel: { label: 'Cancellation', cls: 'kind-cancel' },
  alternative: { label: 'Alternative', cls: 'kind-alt' },
};

export function OpCard({
  op,
  cs,
  now,
  onDecide,
  readOnly = false,
}: {
  op: Op;
  cs: ChangeSet;
  now: number;
  onDecide: (op: Op, how: 'approve' | 'decline') => void;
  readOnly?: boolean;
}) {
  const status = E.effectiveOpStatus(cs, op, now);
  const badge = KIND_BADGE[op.kind]!;
  const showButtons = !readOnly && status === 'proposed';

  return (
    <article className={`op-card status-${status} ${op.isAlternative ? 'alt' : ''}`}>
      <header>
        <span className={`badge ${badge.cls}`}>{badge.label}</span>
        <strong>{describeOp(op)}</strong>
        <StatusPill status={status} />
      </header>

      <div className="op-detail">
        {op.before && op.after && (
          <dl className="diff">
            {Object.entries(op.patch).map(([k, after]) => (
              <div key={k} className="diff-row">
                <dt>{k}</dt>
                <dd>
                  {fmtParamValue(op.before![k])} → <strong>{fmtParamValue(after)}</strong>
                </dd>
              </div>
            ))}
          </dl>
        )}
        {op.after && !op.before && (
          <dl className="diff">
            {Object.entries(op.after).map(([k, v]) => (
              <div key={k} className="diff-row">
                <dt>{k}</dt>
                <dd>{fmtParamValue(v)}</dd>
              </div>
            ))}
          </dl>
        )}
        {op.dependsOn && (
          <p className="cause">Because {op.dependsOn.join(' + ')} changed</p>
        )}
      </div>

      <div className="op-money">
        {op.fee > 0 && (
          <span className="fee">
            Cancellation fee <strong>${op.fee}</strong> — charged now, sunk once applied
          </span>
        )}
        {op.costDelta !== 0 && (
          <span className="cost">
            Cost {op.costDelta > 0 ? '+' : ''}${op.costDelta}
          </span>
        )}
        {op.irreversibleNote && <span className="irreversible">{op.irreversibleNote}</span>}
      </div>

      {status === 'rejected' && (
        <p className="rejection" role="alert">
          Rejected at execution: {op.reason ?? 'service policy'}
        </p>
      )}
      {status === 'declined' && (
        <p className="muted">{op.reason ?? 'Declined — stays as booked.'}</p>
      )}
      {status === 'expired' && (
        <p className="muted">{op.reason ?? 'Decision window expired — nothing executed.'}</p>
      )}
      {status === 'superseded' && (
        <p className="muted">{op.reason ?? 'Superseded by a newer change.'}</p>
      )}
      {status === 'executed' && <p className="ok-text">Applied.</p>}
      {status === 'approved' && <p className="ok-text">Approved — apply below.</p>}

      {showButtons && (
        <div className="op-actions">
          <button
            className={op.requiresConsent ? 'primary warnbtn' : 'primary'}
            onClick={() => onDecide(op, 'approve')}
          >
            {op.fee > 0 ? `Approve with $${op.fee} fee` : 'Approve'}
          </button>
          <button onClick={() => onDecide(op, 'decline')}>Decline</button>
        </div>
      )}
      {!showButtons && !readOnly && status !== 'proposed' && (
        <p className="muted small">Consents bind to this exact payload at facts v{cs.factsVersion}.</p>
      )}
    </article>
  );
}

function StatusPill({ status }: { status: string }) {
  return <span className={`pill pill-${status}`}>{status.replace(/_/g, ' ')}</span>;
}
