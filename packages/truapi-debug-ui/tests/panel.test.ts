// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The panel's mount and teardown on the page: its container, timers and bus subscription. What the panel shows and
// does is in the Panel stories beside it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DebugBus } from '@dotli/truapi-debug';
import { createDebugBus } from '@dotli/truapi-debug/testing';
import { fakeDebugPanelHost } from '../src/host.fake.js';
import { setupTruapiDebugPanel } from '../src/truapiDebugPanel.js';
import { PANEL_ID } from '../src/Panel.js';
import { buildTruapiEvent } from '../src/testing/buildTruapiEvent.js';

let bus: DebugBus;
let disposers: (() => void)[] = [];

beforeEach(() => {
  // A fixed start keeps the 16 ms animation-frame grid aligned, so frame timings are reproducible.
  vi.useFakeTimers({ now: new Date(2026, 8, 25, 12, 34, 56, 789) });
  document.body.replaceChildren();
  localStorage.clear();
  bus = createDebugBus();
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

function countRows(): number {
  return document.querySelectorAll(`#${PANEL_ID} [data-testid="td-list"] [data-testid="td-row"]`).length;
}

function readCounts(): string | null | undefined {
  return document.querySelector(`#${PANEL_ID} [data-testid="td-counts"]`)?.textContent;
}

function emitRequest(requestId: string): void {
  bus.emit(buildTruapiEvent({ tag: 'a_request', requestId }));
}

/** Let one animation frame pass, so a scheduled render runs. */
function passFrame(): void {
  vi.advanceTimersByTime(20);
}

describe('truapi debug panel: mount and dispose', () => {
  it('As a dotli developer, I set the panel up again while it is mounted and nothing changes', () => {
    // Given
    mount();
    emitRequest('r1');
    passFrame();

    // When
    const secondDispose = mount();
    secondDispose();

    // Then
    expect(document.querySelectorAll(`#${PANEL_ID}`)).toHaveLength(1);
    expect(countRows()).toBe(1);
    expect(readCounts()).toBe('1 events');
  });

  it('As a dotli developer, I dispose the panel and it leaves the page with every timer and subscription stopped', () => {
    // Given
    const dispose = mount();
    emitRequest('r1');
    passFrame();

    // When
    dispose();
    const timersAfterDispose = vi.getTimerCount();
    emitRequest('r2');

    // Then
    expect(document.getElementById(PANEL_ID)).toBeNull();
    expect(timersAfterDispose).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(bus.hasListeners()).toBe(false);
  });
});
