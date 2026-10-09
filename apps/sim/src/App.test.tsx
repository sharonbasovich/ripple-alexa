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

async function setArrival(value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Preview change');
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
  const fresh = E.recallByFact(saved.world, 'arrival', saved.now);
  const panel = recallPanel();
  const rows = [...panel.querySelectorAll('li')];
  const operations = [...fresh.appliedHistory, ...fresh.pendingOperations];
  expect(rows).toHaveLength(operations.length);
  for (const [i, change] of operations.entries()) {
    expect(rows[i]?.textContent).toContain(`${change.label}:`);
    for (const [key, value] of Object.entries(change.kind === 'update' ? change.patch : change.after ?? {})) {
      expect(rows[i]?.textContent).toContain(`${key} → ${fmtParamValue(value)}`);
    }
    const status = { proposed: 'proposed, awaiting decision', approved: 'approved, awaiting apply', applied: 'applied earlier' };
    expect(rows[i]?.querySelector('em')?.textContent).toBe(`(${status[change.state]})`);
  }
  if (!operations.length) expect(panel.textContent).toContain('Nothing was changed by that fact.');
  expect(panel.textContent).toContain(`Unaffected: ${fresh.unaffectedCommitments.map((c) => c.label).join(', ')}`);
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
  it('shows applied history and newer pending changes together through approval, execution and reload', async () => {
    await editArrival();
    await click('What changed because of the flight?');
    await click('Approve', familyOp());
    await click('Apply 1 approved change');
    await setArrival('2026-10-17T10:40');
    expectFreshRecall();
    expect(recallPanel().querySelector('[aria-label="Applied history"]')?.textContent).toContain('Saturday 09:40');
    expect(recallPanel().querySelector('[aria-label="Current pending changes"]')?.textContent).toContain('Saturday 10:40');
    await click('Approve', familyOp());
    expectFreshRecall();
    expect(recallPanel().querySelector('[aria-label="Current pending changes"]')?.textContent).toContain('approved, awaiting apply');
    await click('Apply 1 approved change');
    const fresh = expectFreshRecall();
    expect(fresh.appliedHistory.filter(o => o.commitmentId === 'calendar:visit')).toHaveLength(2);
    expect(recallPanel().querySelector('[aria-label="Current pending changes"]')?.textContent ?? '').not.toContain('Family visit');
    await click('Close', recallPanel());
    await act(async () => root.unmount());
    await mount();
    await click('What changed because of the flight?');
    expectFreshRecall();
    expect(recallPanel().querySelector('[aria-label="Applied history"]')?.textContent).toContain('Saturday 10:40');
  });

  it.each(['decline', 'expiry', 'supersession'] as const)('retains applied history after pending %s', async how => {
    await editArrival();
    await click('Approve', familyOp());
    await click('Apply 1 approved change');
    await click('What changed because of the flight?');
    await setArrival('2026-10-17T10:40');
    if (how === 'decline') await click('Decline', familyOp());
    else if (how === 'expiry') { await click('+6h'); await click('+6h'); }
    else await setArrival('2026-10-17T09:40');
    expectFreshRecall();
    expect(recallPanel().querySelector('[aria-label="Applied history"]')?.textContent).toContain('Saturday 09:40');
    expect(recallPanel().querySelector('[aria-label="Current pending changes"]')?.textContent ?? '').not.toContain('Family visit');
    if (how === 'expiry') {
      await click('Re-check for open decisions (re-proposes against current facts)');
      expectFreshRecall();
      expect(recallPanel().querySelector('[aria-label="Current pending changes"]')?.textContent).toContain('Saturday 10:40');
    }
  });

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
    expect(recallPanel().textContent).toContain('Family visit: start → Saturday 09:40 (applied earlier)');
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
