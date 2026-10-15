// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The panel's mount and teardown on the page: its container, timers and bus subscription. What the panel shows and
// does is in the Panel stories beside it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DotliDebugBus } from '@dotli/truapi-debug';
import { createDotliDebugBus } from '@dotli/truapi-debug/testing';
import { fakeDebugPanelHost } from '../src/host.fake.js';
import { setupTruapiDebugPanel } from '../src/truapi-debug-panel.js';
import { PANEL_ID } from '../src/Panel.js';

let bus: DotliDebugBus;
let disposers: (() => void)[] = [];

beforeEach(() => {
  // A fixed start keeps the 16 ms animation-frame grid aligned, so frame timings are reproducible.
  vi.useFakeTimers({ now: new Date(2026, 8, 25, 12, 34, 56, 789) });
  document.body.replaceChildren();
  localStorage.clear();
  bus = createDotliDebugBus();
  // As `apps/host/src/main.ts` does once it decides the panel will mount.
  bus.enableBuffering();
});

afterEach(() => {
  for (const dispose of disposers) {
    dispose();
  }
  disposers = [];
  vi.useRealTimers();
  document.body.replaceChildren();
});

function mount(): () => void {
  const dispose = setupTruapiDebugPanel({ host: fakeDebugPanelHost().host, bus });
  disposers.push(dispose);
  return dispose;
}

function rowCount(): number {
  return document.querySelectorAll(`#${PANEL_ID} [data-testid="td-list"] [data-testid="td-row"]`).length;
}

function counts(): string | null | undefined {
  return document.querySelector(`#${PANEL_ID} [data-testid="td-counts"]`)?.textContent;
}

function request(requestId: string): void {
  bus.emit({
    kind: 'truapi',
    direction: 'outgoing',
    productId: 'app.dot',
    requestId,
    payload: { tag: 'a_request', value: {} },
  });
}

/** Let one animation frame pass, so a scheduled render runs. */
function frame(): void {
  vi.advanceTimersByTime(20);
}

describe('truapi debug panel: mount and dispose', () => {
  it('As a dotli developer, a second setup while mounted is a no-op', () => {
    // Given
    mount();
    request('r1');
    frame();

    // When
    const secondDispose = mount();
    secondDispose();

    // Then
    expect(document.querySelectorAll(`#${PANEL_ID}`)).toHaveLength(1);
    expect(rowCount()).toBe(1);
    expect(counts()).toBe('1 events');
  });

  it('As a dotli developer, dispose removes the panel and stops every timer and subscription', () => {
    // Given
    const dispose = mount();
    request('r1');
    frame();

    // When
    dispose();

    // Then
    expect(document.getElementById(PANEL_ID)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    request('r2');
    expect(vi.getTimerCount()).toBe(0);
    expect(bus.hasListeners()).toBe(false);
  });
});
