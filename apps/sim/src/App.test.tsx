// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as E from '@ripple/engine';
import App from './App';
import { fmtParamValue, load } from './state';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

let root: Root;
let container: HTMLDivElement;

async function mount() {
  root = createRoot(container);
  await act(async () => root.render(createElement(App)));
}

async function click(label: string, scope: ParentNode = container) {
  const button = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label));
  if (!button || button.disabled) throw new Error(`Missing enabled button: ${label}`);
  await act(async () => button.click());
}

async function editArrival(text = 'Move arrival to Saturday 9:40') {
  await click(text);
  await click('Apply change');
}

function familyOp() {
  const card = [...container.querySelectorAll('.op-card')].find((c) => c.textContent?.includes('Update: Family visit'));
  if (!card) throw new Error('Family visit operation missing');
  return card;
}

function recallPanel() {
  const panel = container.querySelector('[aria-label="Causal recall"]');
  if (!panel) throw new Error('Recall panel missing');
  return panel;
}

// Compare the mounted presentation against a fresh recall of the persisted
// engine world, including patches and omissions after terminal decisions.
function expectFreshRecall() {
  const saved = load();
  if (!saved) throw new Error('Persisted world missing');
  const fresh = E.recallByFact(saved.world, 'arrival');
  const panel = recallPanel();
  const rows = [...panel.querySelectorAll('li')];
  expect(rows).toHaveLength(fresh.changedCommitments.length || 1);
  for (const [i, change] of fresh.changedCommitments.entries()) {
    expect(rows[i]?.textContent).toContain(`${change.label}:`);
    for (const [key, value] of Object.entries(change.whatChanged)) {
      expect(rows[i]?.textContent).toContain(`${key} → ${fmtParamValue(value)}`);
    }
    const status = { proposed: 'proposed, awaiting decision', approved: 'approved, awaiting apply', applied: 'applied' };
    expect(rows[i]?.querySelector('em')?.textContent).toBe(`(${status[change.state]})`);
  }
  if (!fresh.changedCommitments.length) expect(panel.textContent).toContain('Nothing was changed by that fact.');
  expect(panel.querySelector('p')?.textContent).toBe(`Unaffected: ${fresh.unaffected.map((c) => c.label).join(', ')}`);
  return fresh;
}

beforeEach(async () => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  await mount();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('open offline causal recall', () => {
  it('tracks proposed, approved and executed changes without another question', async () => {
    await editArrival();
    await click('What changed because of the flight?');
    expectFreshRecall();
    expect(recallPanel().textContent).toContain('proposed, awaiting decision');

    await click('Approve', familyOp());
    expectFreshRecall();
    expect(recallPanel().textContent).toContain('Family visit: start → Saturday 09:40 (approved, awaiting apply)');

    await click('Apply 1 approved change');
    expectFreshRecall();
    expect(recallPanel().textContent).toContain('Family visit: start → Saturday 09:40 (applied)');
    expect(container.querySelector('[aria-label="Calendar"]')?.textContent).toContain('Saturday 09:40');
  });

  it('removes declined proposals and reflects reopening and persisted reload', async () => {
    await editArrival();
    await click('What changed because of the flight?');
    await click('Decline', familyOp());
    expectFreshRecall();
    expect(recallPanel().querySelector('ul')?.textContent).not.toContain('Family visit:');

    await click('Close', recallPanel());
    expect(container.querySelector('.recall')).toBeNull();
    await click('What changed because of the flight?');
    expectFreshRecall();

    const persisted = localStorage.getItem('ripple:v1');
    await act(async () => root.unmount());
    await mount();
    expect(localStorage.getItem('ripple:v1')).toBe(persisted);
    expect(container.querySelector('.recall')).toBeNull();
    await click('What changed because of the flight?');
    expectFreshRecall();
    expect(recallPanel().querySelector('ul')?.textContent).not.toContain('Family visit:');
  });

  it('drops superseded patches when a fact edit restores the original arrival', async () => {
    await editArrival();
    await click('What changed because of the flight?');
    await click('Approve', familyOp());
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
      // Use the native setter to deliver a real React input event.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '2026-10-16T18:05');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('Preview change');
    await click('Apply change');
    expectFreshRecall();
    expect(recallPanel().textContent).toContain('Nothing was changed by that fact.');
    expect(recallPanel().textContent).not.toContain('Saturday 09:40');
  });

  it('drops expired proposals and approvals after clock advance and shows fresh recheck', async () => {
    await editArrival();
    await click('What changed because of the flight?');
    await click('Approve', familyOp());
    await click('+6h');
    expectFreshRecall();
    await click('+6h');
    expectFreshRecall();
    expect(recallPanel().textContent).toContain('Nothing was changed by that fact.');

    await click('Re-check for open decisions (re-proposes against current facts)');
    expectFreshRecall();
    expect(recallPanel().textContent).toContain('proposed, awaiting decision');
    expect(recallPanel().textContent).not.toContain('approved, awaiting apply');
  });

  it('hides recall on reset and opens against the reset world', async () => {
    await editArrival();
    await click('What changed because of the flight?');
    await click('Reset demo');
    expect(container.querySelector('.recall')).toBeNull();
    await click('What changed because of the flight?');
    expectFreshRecall();
    expect(recallPanel().textContent).toContain('Nothing was changed by that fact.');
  });
});
