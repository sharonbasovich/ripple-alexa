// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { load, persist, seed } from './state';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

let root: Root;
let container: HTMLDivElement;
let writesBlocked: boolean;
const saved = () => localStorage.getItem('ripple:v1');
const warning = () => [...container.querySelectorAll('[role="alert"]')]
  .find(el => el.textContent?.includes('Browser storage'));

async function mount() {
  root = createRoot(container);
  await act(async () => root.render(createElement(App)));
}

async function reload() {
  await act(async () => root.unmount());
  await mount();
}

async function click(label: string, scope: ParentNode = container) {
  const button = [...scope.querySelectorAll('button')].find(b => b.textContent?.trim().startsWith(label));
  if (!button || button.disabled) throw new Error(`Missing enabled button: ${label}`);
  await act(async () => button.click());
}

async function approvedCancellation() {
  await click('Move arrival to Saturday 9:40');
  await click('Apply change');
  const card = [...container.querySelectorAll('.op-card')].find(el => el.textContent?.includes('Cancel: Arrival-day dinner reservation'));
  if (!card) throw new Error('Cancellation proposal missing');
  await click('Approve with $75 fee', card);
}

beforeEach(() => {
  // Clear the previous attempt's status as well as the durable fixture.
  persist(seed());
  localStorage.clear();
  writesBlocked = false;
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (writesBlocked && key === 'ripple:v1') throw new DOMException('Test storage quota', 'QuotaExceededError');
    setItem.call(this, key, value);
  });
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('offline save feedback', () => {
  it('reports the first failed write immediately, keeps warning on repeated failures, and reloads only durable data', async () => {
    writesBlocked = true;
    await mount();
    expect(warning()).toBeDefined(); // No second interaction should be needed.
    expect(saved()).toBeNull();
    await click('+1h');
    await click('+1h');
    expect(warning()).toBeDefined();
    expect(container.querySelector('.sim-time')?.textContent).toContain('Friday 14:00');
    expect(saved()).toBeNull();
    await reload();
    expect(warning()).toBeDefined();
    expect(container.querySelector('.sim-time')?.textContent).toContain('Friday 12:00');
    expect(saved()).toBeNull();
  });

  it('removes the warning immediately after a successful write and persists the current in-memory plan', async () => {
    writesBlocked = true;
    await mount();
    // A presentation-only render also exposes the original stale-warning bug.
    const compact = [...container.querySelectorAll('label')].find(el => el.textContent?.includes('Compact'))!.querySelector('input')!;
    await act(async () => compact.click());
    expect(warning()).toBeDefined();
    writesBlocked = false;
    await click('+1h');
    expect(warning()).toBeUndefined(); // No third interaction to clear stale UI.
    expect(load()?.now).toBe(seed().now + 60 * 60_000);
    const recovered = saved();
    await reload();
    expect(warning()).toBeUndefined();
    expect(saved()).toBe(recovered);
    expect(container.querySelector('.sim-time')?.textContent).toContain('Friday 13:00');
  });

  it('warns on a later failed paid simulation, then saves recovery without executing or charging again', async () => {
    await mount();
    await approvedCancellation();
    const approved = saved();
    writesBlocked = true;
    await click('Apply 1 approved change');
    expect(warning()).toBeDefined();
    expect(saved()).toBe(approved);
    expect(load()?.world.feesCharged).toBe(0); // The failed write is not durable.
    expect(container.querySelector('.budget-pill')?.textContent).toContain('$75 sunk fees');
    writesBlocked = false;
    await click('+1h');
    expect(warning()).toBeUndefined();
    expect(load()?.world.feesCharged).toBe(75);
    const recovered = saved();
    await reload();
    expect(saved()).toBe(recovered);
    expect(load()?.world.feesCharged).toBe(75);
    expect(load()?.world.changeSets.at(-1)?.ops.filter(op => op.status === 'executed')).toHaveLength(1);
  });

  it('reloads the older saved approval after a failed execution save without automatically executing it', async () => {
    await mount();
    await approvedCancellation();
    const approved = saved();
    writesBlocked = true;
    await click('Apply 1 approved change');
    expect(warning()).toBeDefined();
    expect(saved()).toBe(approved);
    await reload();
    expect(warning()).toBeDefined();
    expect(saved()).toBe(approved);
    expect(load()?.world.feesCharged).toBe(0);
    expect(load()?.world.changeSets.at(-1)?.ops.filter(op => op.status === 'approved')).toHaveLength(1);
    expect(container.querySelector('.budget-pill')?.textContent).not.toContain('sunk fees');
    expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Apply 1 approved change')).toBe(true);
  });
});
