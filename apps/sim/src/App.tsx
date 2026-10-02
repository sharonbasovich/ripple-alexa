import { useEffect, useMemo, useState } from 'react';
import * as E from '@ripple/engine';
import type { ChangeSet, FactEdit, Op, World } from '@ripple/engine';
import type { SimState } from './state';
import {
  seed,
  load,
  persist,
  clearPersisted,
  persistFailed,
  previewEdits,
  runUtterance,
  fmtParamValue,
  speakableSummary,
  type Preview,
} from './state';
import { speak, setVoiceEnabled } from './speech';
import { OpCard } from './components/OpCard';
import { ReceiptPanel } from './components/ReceiptPanel';
import { FactPanel } from './components/FactPanel';
import { PlanBoard } from './components/PlanBoard';

const CHIPS = [
  'Move arrival to Saturday 9:40',
  'My brother is joining',
  'Budget $250',
  'Departure Sunday 5pm',
  'What changed because of the flight?',
];

export default function App() {
  const [sim, setSim] = useState<SimState>(() => load() ?? seed());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [notice, setNotice] = useState<string>('');
  const [examples, setExamples] = useState<string[]>([]);
  const [recall, setRecall] = useState<ReturnType<typeof E.recallByFact> | null>(null);
  const [voice, setVoice] = useState(false);
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const [compact, setCompact] = useState(false);

  const w = sim.world;
  const now = sim.now;

  useEffect(() => persist(sim), [sim]);
  useEffect(() => setVoiceEnabled(voice), [voice]);

  const update = (fn: (w: World) => void, speakText?: string) => {
    setSim((s) => {
      const world = structuredClone(s.world);
      fn(world);
      return { ...s, world };
    });
    if (speakText) speak(speakText);
  };

  // combined clock+world update so `now` and transitions stay in lockstep
  const tick = (ms: number) => {
    setSim((s) => {
      const world = structuredClone(s.world);
      const t = s.now + ms;
      E.advanceTime(world, t);
      return { world, now: t };
    });
  };

  const applyEdits = (edits: FactEdit[]) => {
    const p = previewEdits(w, edits);
    setPreview(p);
    if (p.errors.length) setNotice('That change is not valid — nothing was altered.');
  };

  const confirmPreview = () => {
    if (!preview || preview.errors.length) return;
    update((world) => {
      const r = E.changeFacts(world, preview.edits, now);
      if (!r.ok) setNotice(r.errors.join(' '));
      else if (r.noOp) setNotice('No fact actually changed — nothing to do.');
      else setNotice('Change applied — every dependent commitment is below, awaiting your decisions.');
    });
    setPreview(null);
  };

  const decide = (op: Op, how: 'approve' | 'decline') => {
    update((world) => {
      const consent = E.consentFor(world, op);
      const res = how === 'approve' ? E.approve(world, consent, now) : E.decline(world, consent, now);
      setNotice(res.ok ? (how === 'approve' ? 'Approved — apply when ready.' : 'Declined — recorded, it stays as booked.') : res.message);
    });
  };

  const execute = () => {
    update((world) => {
      const outcomes = E.executeApproved(world, now);
      const rej = outcomes.filter((o) => o.status === 'rejected');
      const exe = outcomes.filter((o) => o.status === 'executed');
      const req = outcomes.filter((o) => o.status === 'requoted');
      if (req.length) {
        setNotice(`${req.length} price${req.length === 1 ? '' : 's'} changed since approval — fresh decision required below.`);
      } else if (rej.length && !exe.length) setNotice(`Rejected: ${rej[0]!.reason}`);
      else if (rej.length) setNotice(`${exe.length} applied; ${rej.length} rejected — see honest outcome below.`);
      else if (exe.length) setNotice(`${exe.length} change${exe.length === 1 ? '' : 's'} applied.`);
      else setNotice('Nothing approved yet.');
    });
  };

  const recheck = () => {
    update((world) => {
      E.repropose(world, now, 're-check at your request');
      setNotice('Re-checked against current facts — open decisions are below.');
    });
  };

  const onUtter = (text: string) => {
    const i = runUtterance(w, text, now);
    if (i.type === 'edit') applyEdits(i.edits);
    else if (i.type === 'recall') setRecall(E.recallByFact(w, i.fact));
    else if (i.type === 'status') {
      setNotice(speakableSummary(w, now));
      speak(speakableSummary(w, now));
    } else if (i.type === 'clarify') {
      setExamples(i.examples);
      setNotice(i.message);
    } else {
      setExamples(i.examples);
      setNotice("I didn't understand — no state was changed. Try one of these:");
    }
  };

  const reset = () => {
    clearPersisted();
    const s = seed();
    setSim(s);
    setPreview(null);
    setRecall(null);
    setNotice('Demo reset — only the synthetic local data was cleared.');
  };

  const cs: ChangeSet | undefined = w.changeSets[w.changeSets.length - 1];
  const openCs = E.openChangeSet(w, now);
  const budget = E.budgetStatus(w);
  const decidedOps = useMemo(
    () => (cs ? cs.ops.filter((o) => E.effectiveOpStatus(cs, o, now) === 'approved') : []),
    [cs, now],
  );
  const proposedOps = useMemo(
    () => (cs ? cs.ops.filter((o) => E.effectiveOpStatus(cs, o, now) === 'proposed') : []),
    [cs, now],
  );

  return (
    <div className={`app device-${device} ${compact ? 'compact' : ''}`}>
      <div className="sim-banner" role="note">
        Simulated Alexa+ experience · fictional services, prices &amp; policies · nothing real is
        booked · data stays on this device
      </div>

      <header className="hero">
        <div>
          <h1>Ripple</h1>
          <p className="tagline">
            Change one thing. Everything that depended on it gets repaired — and only that.
          </p>
        </div>
        <div className="hero-flow" aria-label="How it works">
          <span className="flow-chip">Fact changes</span>
          <span className="flow-ripple" aria-hidden="true" />
          <span className="flow-chip">Affected commitments</span>
          <span className="flow-ripple" aria-hidden="true" />
          <span className="flow-chip strong">Your choice</span>
        </div>
        <div className="hero-controls">
          <label className="ctl">
            <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
            Voice
          </label>
          <label className="ctl">
            <input
              type="checkbox"
              checked={device === 'phone'}
              onChange={(e) => setDevice(e.target.checked ? 'phone' : 'desktop')}
            />
            Phone size
          </label>
          <label className="ctl">
            <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} />
            Compact
          </label>
        </div>
      </header>

      <main>
        <section className="primary-card" aria-label="Visit plan">
          <div className="primary-head">
            <div>
              <h2>Family visit</h2>
              <p className="facts-line">
                {E.humanDayTime(E.parseLocal(w.facts.arrival)!)} →{' '}
                {E.humanDayTime(E.parseLocal(w.facts.departure)!)} · {w.facts.guests} adult
                {w.facts.guests === 1 ? '' : 's'} visiting · ${w.facts.budget} budget
              </p>
            </div>
            <div className={`budget-pill ${budget.feasible ? 'ok' : 'over'}`}>
              {budget.feasible
                ? `$${budget.committed + budget.fees} of $${budget.budget}`
                : `Over budget by $${budget.overBy}`}
              <span className="budget-sub">
                {budget.fees > 0 ? `incl. $${budget.fees} sunk fees` : 'no fees'}
              </span>
            </div>
          </div>

          {!budget.feasible && (
            <p className="warn" role="alert">
              This plan cannot satisfy the ${w.facts.budget} budget — projected spend is $
              {budget.projected}. Decline optional charges to bring it back under budget; the app
              will not pretend it fits.
            </p>
          )}

          <PlanBoard world={w} affectedIds={affectedIds(w)} />
        </section>

        <section className="editors" aria-label="Make a change">
          <FactPanel world={w} onPreview={applyEdits} />
          <div className="utterance">
            <h3>Say it instead</h3>
            <UtteranceInput onSubmit={onUtter} />
            <div className="chips">
              {CHIPS.map((c) => (
                <button key={c} className="chip" onClick={() => onUtter(c)}>
                  {c}
                </button>
              ))}
            </div>
            {examples.length > 0 && (
              <ul className="examples">
                {examples.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {openCs && (
          <section className="choices" aria-label="Changes awaiting your decision">
            <h2>
              Needs your decision
              <span className="cs-meta">
                triggered by {openCs.trigger} · decides expire {E.humanDayTime(openCs.expiresAt)}
              </span>
            </h2>
            <div className="op-list">
              {openCs.ops.map((op) => (
                <OpCard key={op.id} op={op} cs={openCs} now={now} onDecide={decide} />
              ))}
            </div>
            {decidedOps.length > 0 && (
              <button className="primary" onClick={execute}>
                Apply {decidedOps.length} approved change{decidedOps.length === 1 ? '' : 's'}
              </button>
            )}
            {proposedOps.length === 0 && decidedOps.length === 0 && (
              <p className="muted">All decisions are recorded.</p>
            )}
          </section>
        )}

        {!openCs && cs && (
          <section className="choices settled" aria-label="Last change set">
            <h2>Latest change set — {cs.status}</h2>
            <div className="op-list">
              {cs.ops.map((op) => (
                <OpCard key={op.id} op={op} cs={cs} now={now} onDecide={decide} readOnly />
              ))}
            </div>
            <button onClick={recheck}>
              Re-check for open decisions (re-proposes against current facts)
            </button>
          </section>
        )}

        {preview && (
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Change preview">
            <div className="modal">
              <h3>Preview — nothing has changed yet</h3>
              {preview.errors.length > 0 ? (
                <ul className="errors">
                  {preview.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              ) : (
                <>
                  <ul className="deltas">
                    {preview.deltas.map((d) => (
                      <li key={d.key}>
                        <strong>{d.key}</strong>: {d.before} → {d.after}
                      </li>
                    ))}
                  </ul>
                  {preview.affected.length > 0 && (
                    <p className="affects">
                      Will touch: {preview.affected.map((a) => a.label).join(', ')}.
                    </p>
                  )}
                  {preview.untouched.length > 0 && (
                    <p className="unaffected">
                      Stays exactly as booked: {preview.untouched.map((a) => a.label).join(', ')}.
                    </p>
                  )}
                  {preview.notes.map((n) => (
                    <p key={n} className="note">
                      {n}
                    </p>
                  ))}
                </>
              )}
              <div className="modal-actions">
                <button className="primary" onClick={confirmPreview} disabled={preview.errors.length > 0}>
                  Apply change
                </button>
                <button onClick={() => setPreview(null)}>Discard</button>
              </div>
            </div>
          </div>
        )}

        {notice && (
          <div className="notice" role="status">
            {notice}
            <button className="x" onClick={() => setNotice('')} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}

        {persistFailed() && (
          <div className="notice warn-inline" role="alert">
            Browser storage is unavailable — changes work now but will NOT survive a reload.
          </div>
        )}

        {recall && (
          <section className="recall" aria-label="Causal recall">
            <h3>What changed because of {recall.fact}?</h3>
            <ul>
              {recall.changedCommitments.map((c) => (
                <li key={c.id}>
                  {c.label}: {describePatch(c.whatChanged)}{' '}
                  <em className="muted">
                    ({c.state === 'pending' ? 'approved, awaiting apply' : 'applied'})
                  </em>
                </li>
              ))}
              {recall.changedCommitments.length === 0 && (
                <li className="muted">Nothing was changed by that fact.</li>
              )}
            </ul>
            <p className="muted">
              Unaffected: {recall.unaffected.map((c) => c.label).join(', ')}
            </p>
            <button onClick={() => setRecall(null)}>Close</button>
          </section>
        )}

        <ReceiptPanel world={w} />

        <section className="sim-controls" aria-label="Simulation controls">
          <span className="sim-time">
            Simulated time: <strong>{E.humanDayTime(now)}</strong>
          </span>
          <div className="sim-buttons">
            <button onClick={() => tick(60 * 60_000)}>+1h</button>
            <button onClick={() => tick(6 * 60 * 60_000)}>+6h</button>
            <button onClick={() => tick(24 * 60 * 60_000)}>+1 day</button>
            <button onClick={() => speak(speakableSummary(w, now))}>Speak summary</button>
            <button className="danger" onClick={reset}>
              Reset demo — clears synthetic local data only
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

function affectedIds(w: World): Set<string> {
  const cs = w.changeSets[w.changeSets.length - 1];
  if (!cs) return new Set();
  return new Set(cs.ops.filter((o) => o.status === 'proposed' || o.status === 'approved').map((o) => o.commitmentId));
}

function describePatch(patch: Record<string, unknown>): string {
  const parts = Object.entries(patch).map(([k, v]) => `${k} → ${fmtParamValue(v)}`);
  return parts.length ? parts.join(', ') : '(rescheduled)';
}

function UtteranceInput({ onSubmit }: { onSubmit: (t: string) => void }) {
  const [v, setV] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onSubmit(v);
        setV('');
      }}
    >
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="e.g. Move arrival to Saturday 9:40"
        aria-label="Tell Alexa what changed"
      />
      <button type="submit">Send</button>
    </form>
  );
}
