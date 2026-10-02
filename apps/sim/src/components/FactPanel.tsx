import { useState } from 'react';
import type { FactEdit, World } from '@ripple/engine';
import { collectEdits } from '../state';

// datetime-local values are wall-clock strings like 2026-10-16T18:05 —
// the engine's simulated local time uses exactly this format.

export function FactPanel({
  world,
  onPreview,
}: {
  world: World;
  onPreview: (edits: FactEdit[]) => void;
}) {
  const f = world.facts;
  const [arrival, setArrival] = useState(f.arrival);
  const [departure, setDeparture] = useState(f.departure);
  const [guests, setGuests] = useState(String(f.guests));
  const [budget, setBudget] = useState(String(f.budget));
  const [dirty, setDirty] = useState(false);

  // Resync untouched inputs whenever facts change elsewhere (chips,
  // utterances, reset) — the "adjust state during render" pattern. Without
  // this a stale field could silently revert a newer fact on the next submit.
  const [lastVersion, setLastVersion] = useState(world.factsVersion);
  if (lastVersion !== world.factsVersion) {
    setLastVersion(world.factsVersion);
    setArrival(f.arrival);
    setDeparture(f.departure);
    setGuests(String(f.guests));
    setBudget(String(f.budget));
    setDirty(false);
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const edits = collectEdits(f, { arrival, departure, guests, budget });
    if (edits === null) {
      onPreview([{ key: 'guests', value: 'invalid' }]); // surfaces a validation error honestly
      return;
    }
    if (edits.length) onPreview(edits);
    setDirty(false);
  };

  const track =
    (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
      set(e.target.value);
      setDirty(true);
    };

  return (
    <div className="fact-editor">
      <h3>Edit facts directly</h3>
      <form onSubmit={submit} className="fact-form">
        <label>
          Arrival
          <input
            type="datetime-local"
            value={arrival}
            min="2026-10-12T00:00"
            max="2026-10-25T23:59"
            onChange={track(setArrival)}
          />
        </label>
        <label>
          Departure
          <input
            type="datetime-local"
            value={departure}
            min="2026-10-12T00:00"
            max="2026-10-25T23:59"
            onChange={track(setDeparture)}
          />
        </label>
        <label>
          Adults visiting
          <input
            type="number"
            min="1"
            max="8"
            step="1"
            value={guests}
            onChange={track(setGuests)}
          />
        </label>
        <label>
          Budget ($)
          <input
            type="number"
            min="0"
            max="100000"
            step="1"
            value={budget}
            onChange={track(setBudget)}
          />
        </label>
        <button type="submit" className="primary" disabled={!dirty}>
          Preview change
        </button>
      </form>
      <p className="muted small">
        Changes validate and preview first — nothing executes until you approve the diff.
      </p>
    </div>
  );
}
