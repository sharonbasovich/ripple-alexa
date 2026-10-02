import { useState } from 'react';
import type { FactEdit, World } from '@ripple/engine';

// datetime-local values are wall-clock strings like 2026-10-16T18:05 —
// the engine's simulated local time uses exactly this format.
const toInput = (iso: string) => iso;

export function FactPanel({
  world,
  onPreview,
}: {
  world: World;
  onPreview: (edits: FactEdit[]) => void;
}) {
  const f = world.facts;
  const [arrival, setArrival] = useState(toInput(f.arrival));
  const [departure, setDeparture] = useState(toInput(f.departure));
  const [guests, setGuests] = useState(String(f.guests));
  const [budget, setBudget] = useState(String(f.budget));
  const [dirty, setDirty] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const edits: FactEdit[] = [];
    if (arrival !== f.arrival) edits.push({ key: 'arrival', value: arrival });
    if (departure !== f.departure) edits.push({ key: 'departure', value: departure });
    if (Number(guests) !== f.guests) edits.push({ key: 'guests', value: guests });
    if (Number(budget) !== f.budget) edits.push({ key: 'budget', value: budget });
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
