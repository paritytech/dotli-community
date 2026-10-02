// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Regression test for the early-buffer replay timing: the panel subscribes
// to the dotli debug bus before it mounts, so events buffered while nothing
// was listening (boot-phase traffic) land in the store before the panel
// takes its initial snapshot. They must be visible in the very first paint,
// with no animation frame advanced — advancing a frame would also let the
// panel's own `store.subscribe` commit path paper over a wrong subscribe
// order.
//
// Reuses the characterization suite's stubbing approach (`./panel.test.ts`),
// which is left untouched; this is a separate, narrowly scoped file.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPanel, type PanelModule } from './panel-entry.js';
import type * as DotliDebugBusModule from '../../../truapi-debug/src/dotli-debug-bus.js';
import { query } from '../support.js';

type Bus = typeof DotliDebugBusModule;
type BusEvent = Parameters<Bus['emitDotliDebugEvent']>[0];

const PANEL_ID = 'truapi-debug-panel';

let bus: Bus;
let panelModule: PanelModule;
let disposers: (() => void)[] = [];

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date(2026, 8, 25, 12, 34, 56, 789) });
  vi.resetModules();
  document.head.replaceChildren();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  bus = await import('../../../truapi-debug/src/dotli-debug-bus.js');
  panelModule = await loadPanel();
  // As `apps/host/src/main.ts` does once it decides the panel will mount.
  bus.enableDotliDebugBuffering();
});

afterEach(() => {
  for (const dispose of disposers) {
    dispose();
  }
  disposers = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

function mount(): () => void {
  const dispose = panelModule.setupTruapiDebugPanel();
  disposers.push(dispose);
  return dispose;
}

function panel(): HTMLElement {
  const el = document.getElementById(PANEL_ID);
  if (el === null) {
    throw new Error('panel is not mounted');
  }
  return el;
}

function q(selector: string): HTMLElement {
  return query(panel(), selector);
}

function rows(): HTMLElement[] {
  return [...panel().querySelectorAll<HTMLElement>('[data-testid="td-list"] [data-testid="td-row"]')];
}

function rowTags(): string[] {
  return rows().map(r => r.querySelector('[data-testid="td-tag"]')?.textContent ?? '');
}

function counts(): string {
  return q('[data-testid="td-counts"]').textContent;
}

function truapi(tag: string, requestId: string): void {
  bus.emitDotliDebugEvent({
    kind: 'truapi',
    direction: 'outgoing',
    productId: 'app.dot',
    requestId,
    payload: { tag, value: {} },
  });
}

function system(layer: string, event: string, flowId: string, payload: Record<string, unknown> = {}): void {
  bus.emitDotliDebugEvent({
    layer,
    event,
    flowId,
    timestamp: Date.now(),
    payload,
  } as unknown as BusEvent);
}

describe('truapi debug panel: early-buffer replay timing', () => {
  it('As a dotli developer, buffered boot events are rendered right after setup, before any animation frame', () => {
    // Given the bus is buffering (beforeEach) and nothing listens yet
    system('boot', 'started', 'flow-early', { chainBackend: 'smoldot' });
    truapi('early_request', 'early-1');

    // When the panel mounts — no `frame()` advance follows
    mount();

    // Then the buffered events are already in the first paint
    expect(rowTags()).toEqual(['boot.started', 'early_request']);
    expect(counts()).toBe('2 events');
  });
});
