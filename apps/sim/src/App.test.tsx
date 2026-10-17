// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as E from '@ripple/engine';
import App from './App';
import { fmtParamValue, load } from './state';
import * as Speech from './speech';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

let root: Root;
let container: HTMLDivElement;

async function mount() {
  root = createRoot(container);
  await act(async () => root.render(createElement(App)));
}

it('routes static MCP setup back to the working preview without resetting a plan', async () => {
  await act(async () => root.render(createElement(App, { allowMcpConnect: false })));
  await editArrival();
  const saved = localStorage.getItem('ripple:v1');
  await click('Local MCP setup');
  expect(container.querySelector<HTMLButtonElement>('.mcp-actions button')?.disabled).toBe(true);
  expect(container.textContent).toContain('Try the interactive plan here');
  await click('Try offline preview');
  expect(document.activeElement).toBe(container.querySelector('.demo-mode-switch button'));
  expect(container.querySelector('[aria-label="Visit plan"]')).not.toBeNull();
  expect(localStorage.getItem('ripple:v1')).toBe(saved);
  expect(container.textContent).toContain('Saturday 09:40');
});

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

async function askStatus() {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Tell Alexa what changed"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Status');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  return container.querySelector('.notice[role="status"]')?.firstChild?.textContent ?? '';
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
  vi.restoreAllMocks();
});

describe('expired offline status', () => {
  it.each(['unapproved', 'approved', 'partial'] as const)('keeps typed and spoken Status truthful and read-only for %s expiry, reload and re-check', async how => {
    const speak = vi.spyOn(Speech, 'speak').mockImplementation(() => {});
    await editArrival();
    if (how === 'approved') await click('Approve', familyOp());
    if (how === 'partial') {
      await click('Approve with $75 fee');
      await click('Apply 1 approved change');
    }
    await click('+6h');
    await click('+6h');
    const before = localStorage.getItem('ripple:v1');
    const text = await askStatus();
    expect(localStorage.getItem('ripple:v1')).toBe(before);
    expect(text).not.toContain('settled');
    expect(text).toContain('expired without being applied');
    expect(text).toContain('Re-check for open decisions');
    expect(text).toContain(`${how === 'partial' ? 6 : 7} changes expired`);
    expect(text.split(/\s+/).length).toBeLessThan(75);
    expect(speak).toHaveBeenLastCalledWith(text);
    const callsBeforeSpeak = speak.mock.calls.length;
    await click('Speak summary');
    expect(speak).toHaveBeenCalledTimes(callsBeforeSpeak + 1);
    expect(speak).toHaveBeenLastCalledWith(text);
    expect(localStorage.getItem('ripple:v1')).toBe(before);
    expect(load()?.world.feesCharged).toBe(how === 'partial' ? 75 : 0);
    await act(async () => root.unmount());
    await mount();
    expect(localStorage.getItem('ripple:v1')).toBe(before);
    expect(await askStatus()).toBe(text);
    expect(localStorage.getItem('ripple:v1')).toBe(before);
    await click('Re-check for open decisions');
    const refreshed = localStorage.getItem('ripple:v1');
    const freshText = await askStatus();
    expect(freshText).toContain('need your decision');
    expect(freshText).not.toContain('expired');
    expect(speak).toHaveBeenLastCalledWith(freshText);
    expect(localStorage.getItem('ripple:v1')).toBe(refreshed);
    expect(load()?.world.feesCharged).toBe(how === 'partial' ? 75 : 0);
  });
});

describe('rejected offline status', () => {
  it.each(['terminal', 'pending', 'approved', 'expired', 'grocery declined'] as const)('keeps typed and spoken summaries truthful for supported %s rejection and reload', async how => {
    const speak = vi.spyOn(Speech, 'speak').mockImplementation(() => {});
    const grocery = how === 'grocery declined';
    if (!grocery) await click('+6h');
    await editArrival();
    const card = (label: string) => [...container.querySelectorAll('.op-card')].find(el => el.textContent?.includes(label))!;
    if (!grocery) await click('Approve', familyOp());
    await click('Approve', card(grocery ? 'Update: Arrival-day grocery delivery' : 'Update: Guest welcome routine'));
    const keepCoffee = ['pending', 'approved', 'expired'].includes(how);
    let undecided: Element | undefined;
    while ((undecided = [...container.querySelectorAll('.op-card')].find(el =>
      [...el.querySelectorAll('button')].some(b => b.textContent === 'Decline') &&
      !(keepCoffee && el.textContent?.includes('Update: Morning coffee routine'))))) await click('Decline', undecided);
    if (!grocery) await click('+6h');
    await click(`Apply ${grocery ? '1' : '2'} approved change`);
    expect(load()?.world.changeSets.at(-1)?.ops.filter(op => op.status === 'rejected')).toHaveLength(1);
    if (grocery) await click('Decline');
    if (how === 'approved') await click('Approve');
    if (how === 'expired') await click('+6h');
    const before = localStorage.getItem('ripple:v1');
    const text = await askStatus();
    expect(text).toContain('1 change was rejected and not applied');
    expect(text).toContain('Review rejected change cards');
    expect(text).not.toContain('settled');
    if (how === 'pending') expect(text).toContain('1 change need your decision');
    if (how === 'approved') expect(text).toContain('1 approved change ready to apply');
    if (how === 'expired') expect(text).toContain('1 change expired without being applied');
    expect(text).toContain('spend is $196 of a $300 budget');
    expect(text.split(/\s+/).length).toBeLessThan(75);
    expect(speak).toHaveBeenLastCalledWith(text);
    expect(localStorage.getItem('ripple:v1')).toBe(before);
    const calls = speak.mock.calls.length;
    await click('Speak summary');
    expect(speak).toHaveBeenCalledTimes(calls + 1);
    expect(speak).toHaveBeenLastCalledWith(text);
    expect(localStorage.getItem('ripple:v1')).toBe(before);
    await act(async () => root.unmount());
    await mount();
    expect(localStorage.getItem('ripple:v1')).toBe(before);
    expect(await askStatus()).toBe(text);
    expect(speak).toHaveBeenLastCalledWith(text);
    expect(localStorage.getItem('ripple:v1')).toBe(before);
  });
});

describe('consecutive offline fact previews', () => {
  it('previews carried arrival repairs and approval replacement before a budget-only change', async () => {
    await editArrival();
    await click('Approve', familyOp());
    const before = localStorage.getItem('ripple:v1');
    await click('Budget $250');
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(localStorage.getItem('ripple:v1')).toBe(before);
    expect(dialog.querySelector('.unaffected')?.textContent).not.toContain('Family visit');
    expect(dialog.querySelector('.carried-forward')?.textContent).toContain('Family visit');
    expect(dialog.querySelector('.affects')).toBeNull();
    expect(dialog.textContent).toContain('approvals');
    await click('Discard', dialog);
    expect(localStorage.getItem('ripple:v1')).toBe(before);
    expect(load()?.world.changeSets.at(-1)?.ops.some(op => op.status === 'approved')).toBe(true);
    await click('Budget $250');
    await click('Apply change');
    expect(load()?.world.feesCharged).toBe(0);
    expect(load()?.world.changeSets.at(-1)?.ops.every(op => op.status === 'proposed')).toBe(true);
    expect(container.textContent).not.toContain('Apply 1 approved change');
    await click('Approve with $75 fee');
    await click('Apply 1 approved change');
    expect(load()?.world.feesCharged).toBe(75);
  });

  it.each(['declined', 'expired'] as const)('separates revised guest repairs from carried arrival differences after %s decisions', async status => {
    await editArrival();
    if (status === 'declined') {
      while ([...container.querySelectorAll('button')].some(b => b.textContent === 'Decline')) await click('Decline');
    } else { await click('+6h'); await click('+6h'); }
    const before = localStorage.getItem('ripple:v1');
    await click('My brother is joining');
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('.affects')?.textContent).toContain('Family visit');
    expect(dialog.querySelector('.affects')?.textContent).not.toContain('Airport pickup');
    expect(dialog.querySelector('.carried-forward')?.textContent).toContain('Airport pickup');
    expect(dialog.querySelector('.carried-forward')?.textContent).not.toContain('Family visit');
    expect(dialog.querySelector('.unaffected')?.textContent).toBe('No repair proposed for: Departure-day lock-up routine.');
    expect(dialog.textContent).toContain('declined or expired choices');
    expect(localStorage.getItem('ripple:v1')).toBe(before);
    await click('Discard');
    expect(localStorage.getItem('ripple:v1')).toBe(before);
    await click('My brother is joining');
    await click('Apply change');
    expect(load()?.world.changeSets.at(-1)?.ops.every(op => op.status === 'proposed')).toBe(true);
    expect(load()?.world.feesCharged).toBe(0);
  });

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

async function submitUtterance(text: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Tell Alexa what changed"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Send');
}

describe('arrival correction from an invalid weekday preview', () => {
  it('shows exact dates, opens a fresh correction preview, and waits for Apply before persistence', async () => {
    await editArrival('New plan: arrive Sat 9:40');
    const before = localStorage.getItem('ripple:v1');
    await submitUtterance('Arrive Friday 18:05');
    let dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Friday 2026-10-23 18:05');
    expect(dialog.textContent).toContain('Departure stays Sunday 2026-10-18 17:00');
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('Arrival must be before departure');
    expect(document.activeElement?.textContent).toBe('Preview Friday 2026-10-16 18:05 instead');
    expect([...dialog.querySelectorAll('button')].find(b => b.textContent === 'Apply change')?.disabled).toBe(true);
    expect(localStorage.getItem('ripple:v1')).toBe(before);

    await click('Preview Friday 2026-10-16 18:05 instead');
    dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[role="alert"]')).toBeNull();
    expect(dialog.textContent).toContain('Friday 2026-10-16 18:05');
    expect(document.activeElement?.textContent).toBe('Apply change');
    expect(localStorage.getItem('ripple:v1')).toBe(before);
    await click('Discard');
    expect(localStorage.getItem('ripple:v1')).toBe(before);

    await submitUtterance('Arrive Friday 18:05');
    await click('Preview Friday 2026-10-16 18:05 instead');
    await click('Apply change');
    expect(load()?.world.facts).toEqual({ ...E.FIXTURE_FACTS, guests: 3 });
    await act(async () => root.unmount());
    await mount();
    expect(load()?.world.facts.arrival).toBe('2026-10-16T18:05');
  });

  it('accepts an explicitly dated command through the composer without implicitly applying it', async () => {
    await editArrival();
    const before = localStorage.getItem('ripple:v1');
    await submitUtterance('Arrive 2026-10-16 18:05');
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Friday 2026-10-16 18:05');
    expect(localStorage.getItem('ripple:v1')).toBe(before);
    await click('Apply change');
    expect(load()?.world.facts).toEqual(E.FIXTURE_FACTS);
  });

  it('focuses Discard when an invalid trip has no safe correction', async () => {
    await editArrival();
    const before = localStorage.getItem('ripple:v1');
    await submitUtterance('Arrive Monday 9:40');
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Monday 2026-10-19 09:40');
    expect(dialog.textContent).toContain('Choose exact dates');
    expect(document.activeElement?.textContent).toBe('Discard');
    expect(localStorage.getItem('ripple:v1')).toBe(before);
  });
});
