// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The debug panel as the host mounts it, on a bus of the story's own, with page effects and the panel's computations
// counted. Plays reach the mounted panel and the bus through `debugPanel()`.

import type { SolidRenderer } from 'storybook-solidjs-vite';
import type { StoryContext } from 'storybook/internal/types';
import { expect, fn, waitFor } from 'storybook/test';
import type { DotliDebugBus, DotliDebugBusEvent } from '@dotli/truapi-debug';
import { createDotliDebugBus } from '@dotli/truapi-debug/testing';
import { fakeDebugPanelHost, type FakeDebugPanelHost } from '../../host.fake.js';
import type { KeyedSignals } from '../../keyed-signals.js';
import { setupTruapiDebugPanel } from '../../truapi-debug-panel.js';
import { NARROW_QUERY, PANEL_ID } from '../../Panel.js';
import type { PanelEffects } from '../../effects.js';
import { panelWork, type PanelWork } from '../../work.js';

/** How often each of the panel's repeated computations ran. */
export type WorkCalls = {
  matches: number;
  formatPending: number;
  rowSelection: number;
  buildTimeline: number;
  buildResolution: number;
};

export type TruapiInput = {
  tag: string;
  requestId: string;
  direction?: 'incoming' | 'outgoing';
  /** `null` emits an event without a product id. */
  productId?: string | null;
  value?: unknown;
};

export type DebugPanelStory = {
  bus: DotliDebugBus;
  /** The host page the panel reads, which a play sets. */
  host: FakeDebugPanelHost;
  effects: {
    writeClipboard: ReturnType<typeof fn<PanelEffects['writeClipboard']>>;
    download: ReturnType<typeof fn<PanelEffects['download']>>;
  };
  calls: WorkCalls;
  /** The per-row signal maps the panel made, to see which keys it still holds. */
  keyedMaps: KeyedSignals<unknown, unknown>[];
  /** Mounts the panel. The story ends with it disposed. */
  mount: (options?: { capacity?: number | undefined; startCollapsed?: boolean | undefined }) => () => void;
  truapi: (input: TruapiInput) => void;
  system: (layer: string, event: string, flowId: string, payload?: Record<string, unknown>) => void;
};

/** Where the story page's content starts, in px, below a bar the page does not draw. */
export const CONTENT_TOP = 52;

let current: DebugPanelStory | undefined;

/** The story's panel harness, set up by `debugPanelBeforeEach`. */
export function debugPanel(): DebugPanelStory {
  if (current === undefined) {
    throw new Error('The story has no debug panel harness');
  }
  return current;
}

function countingWork(real: PanelWork, calls: WorkCalls, keyedMaps: KeyedSignals<unknown, unknown>[]): PanelWork {
  return {
    matches: (...args) => {
      calls.matches++;
      return real.matches(...args);
    },
    formatPending: (...args) => {
      calls.formatPending++;
      return real.formatPending(...args);
    },
    rowSelection: (...args) => {
      calls.rowSelection++;
      return real.rowSelection(...args);
    },
    buildTimeline: (...args) => {
      calls.buildTimeline++;
      return real.buildTimeline(...args);
    },
    buildResolution: (...args) => {
      calls.buildResolution++;
      return real.buildResolution(...args);
    },
    createKeyedSignals: <K, V>() => {
      const map = real.createKeyedSignals<K, V>();
      keyedMaps.push(map);
      return map;
    },
  };
}

/** Zeroes the counts, so a play counts only what follows. */
export function resetCalls(calls: WorkCalls): void {
  for (const key of Object.keys(calls) as (keyof WorkCalls)[]) {
    calls[key] = 0;
  }
}

/** How a story mounts the panel, as its `debugPanel` parameter. */
export type DebugPanelParameters = {
  /** False leaves the mount to the play, as for one on fake timers. */
  mount?: boolean;
  capacity?: number;
  startCollapsed?: boolean;
};

/**
 * The stories' `beforeEach`: a buffering bus as the host's entry leaves it, the panel's stored choices cleared, and
 * the panel mounted as the `debugPanel` parameter says. Returns the cleanup.
 */
export function debugPanelBeforeEach(context: { parameters: Record<string, unknown> }): () => void {
  const options = (context.parameters['debugPanel'] ?? {}) as DebugPanelParameters;
  localStorage.removeItem('truapi-debug:section');
  localStorage.removeItem('truapi-debug:dock');
  const bus = createDotliDebugBus();
  bus.enableBuffering();
  const calls: WorkCalls = { matches: 0, formatPending: 0, rowSelection: 0, buildTimeline: 0, buildResolution: 0 };
  const keyedMaps: KeyedSignals<unknown, unknown>[] = [];
  const work = countingWork(panelWork, calls, keyedMaps);
  const effects = {
    writeClipboard: fn<PanelEffects['writeClipboard']>(() => Promise.resolve()),
    download: fn<PanelEffects['download']>(),
  };
  const disposers: (() => void)[] = [];
  const host = fakeDebugPanelHost({ contentInsets: { top: `${String(CONTENT_TOP)}px`, bottom: '0px' } });
  const story: DebugPanelStory = {
    bus,
    host,
    effects,
    calls,
    keyedMaps,
    mount: (mountOptions = {}) => {
      const dispose = setupTruapiDebugPanel({
        host: host.host,
        bus,
        effects,
        work,
        ...(mountOptions.capacity === undefined ? {} : { capacity: mountOptions.capacity }),
        ...(mountOptions.startCollapsed === undefined ? {} : { startCollapsed: mountOptions.startCollapsed }),
      });
      disposers.push(dispose);
      return dispose;
    },
    truapi: input => {
      bus.emit({
        kind: 'truapi',
        direction: input.direction ?? 'outgoing',
        ...(input.productId !== null ? { productId: input.productId ?? 'app.dot' } : {}),
        requestId: input.requestId,
        payload: { tag: input.tag, value: input.value ?? {} },
      });
    },
    system: (layer, event, flowId, payload = {}) => {
      bus.emit({ layer, event, flowId, timestamp: Date.now(), payload } as unknown as DotliDebugBusEvent);
    },
  };
  current = story;
  if (options.mount !== false) {
    story.mount({ capacity: options.capacity, startCollapsed: options.startCollapsed });
  }
  return () => {
    for (const dispose of disposers) {
      dispose();
    }
    current = undefined;
    localStorage.removeItem('truapi-debug:section');
    localStorage.removeItem('truapi-debug:dock');
  };
}

/** The mounted panel. */
export function panel(): HTMLElement {
  const el = document.getElementById(PANEL_ID);
  if (el === null) {
    throw new Error('The debug panel is not mounted');
  }
  return el;
}

/** The panel's element with `data-testid` `id`, and `value` as its `data-value` when given. */
export function part(id: string, value?: string): HTMLElement {
  const selector = value === undefined ? `[data-testid="${id}"]` : `[data-testid="${id}"][data-value="${value}"]`;
  const el = panel().querySelector<HTMLElement>(selector);
  if (el === null) {
    throw new Error(`No ${selector} in the debug panel`);
  }
  return el;
}

export function rows(): HTMLElement[] {
  return [...panel().querySelectorAll<HTMLElement>('[data-testid="td-list"] [data-testid="td-row"]')];
}

export function rowTag(row: HTMLElement): string {
  return row.querySelector('[data-testid="td-tag"]')?.textContent ?? '';
}

export function rowTags(): string[] {
  return rows().map(rowTag);
}

export function rowByTag(tag: string): HTMLElement {
  const row = rows().find(r => rowTag(r) === tag);
  if (row === undefined) {
    throw new Error(`No row tagged ${tag}`);
  }
  return row;
}

export function counts(): string {
  return part('td-counts').textContent;
}

/** The detail pane's head as name and value. */
export function detailRows(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dt of part('td-detail-head').querySelectorAll('dt')) {
    out[dt.textContent] = dt.nextElementSibling?.textContent ?? '';
  }
  return out;
}

export function selectedTags(): string[] {
  return rows()
    .filter(r => r.getAttribute('data-selection') === 'selected')
    .map(rowTag);
}

/** The timeline box whose tooltip mentions `text`. */
export function timelineBox(text: string): SVGRectElement {
  const box = [
    ...panel().querySelectorAll<SVGRectElement>('[data-testid="td-timeline"] [data-testid="td-tl-segment"]'),
  ].find(r => r.getAttribute('data-tooltip')?.includes(text) === true);
  if (box === undefined) {
    throw new Error(`No timeline box for ${text}`);
  }
  return box;
}

export function resolutionFact(name: string): string {
  return (
    panel().querySelector(`[data-testid="td-res"] [data-testid="td-res-fact"][data-fact="${name}"] dd`)?.textContent ??
    ''
  );
}

/** A handshake request, its response `gapMs` later, and a host boot event. */
export function seedMixedTraffic(advance: (ms: number) => void = () => undefined): void {
  const { truapi, system } = debugPanel();
  truapi({ tag: 'system_handshake_request', requestId: 'req-aaa-111', direction: 'outgoing', value: { version: 1 } });
  advance(50);
  truapi({ tag: 'system_handshake_response', requestId: 'req-aaa-111', direction: 'incoming', value: { ok: true } });
  system('boot', 'started', 'flow-boot-1', { chainBackend: 'smoldot', mode: 'direct', contentBackend: 'helia' });
}

/** Two products, an event without a product and a host boot event. */
export function seedFilterTraffic(): void {
  const { truapi, system } = debugPanel();
  truapi({ tag: 'alpha_request', requestId: 'a1', productId: 'b.dot', direction: 'outgoing' });
  truapi({ tag: 'alpha_response', requestId: 'a1', productId: 'b.dot', direction: 'incoming' });
  truapi({ tag: 'beta_request', requestId: 'b1', productId: 'a.dot', direction: 'incoming' });
  truapi({ tag: 'gamma_request', requestId: 'c1', productId: null, direction: 'outgoing' });
  system('boot', 'started', 'flow-1', { chainBackend: 'smoldot' });
}

/** Fake time for a play. */
export type FakeClock = {
  /** Lets one animation frame pass, so a scheduled render runs. */
  frame: () => void;
  advance: (ms: number) => void;
  /** Timers scheduled and not yet run. */
  timerCount: () => number;
};

/**
 * Runs `play` on vitest's fake timers, from a fixed moment on the 16 ms animation-frame grid, so time-driven rows,
 * badges and ticks are exact. Only under the vitest runner, as the workshop has no fake timers.
 */
export async function withFakeClock(play: (clock: FakeClock) => Promise<void>): Promise<void> {
  const { vi } = await import('vitest');
  vi.useFakeTimers({
    now: new Date(2026, 8, 25, 12, 34, 56, 789),
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });
  try {
    await play({
      frame: () => {
        vi.advanceTimersByTime(20);
      },
      advance: ms => {
        vi.advanceTimersByTime(ms);
      },
      timerCount: () => vi.getTimerCount(),
    });
  } finally {
    vi.useRealTimers();
  }
}

/** The phone variant's guard: the story's viewport really crossed the panel's narrow breakpoint. */
export async function expectPhone(step: StoryContext<SolidRenderer>['step']): Promise<void> {
  await step('Given the phone viewport', async () => {
    await waitFor(() => expect(window.matchMedia(NARROW_QUERY).matches).toBe(true));
  });
}

function pointerEvent(target: Element, type: string, x = 0, y = 0): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: y }));
}

/** A drag of `handle` in progress. */
export type Grab = {
  to: (x: number, y: number) => void;
  release: (end?: 'pointerup' | 'pointercancel') => void;
};

/** Presses the pointer on `handle`, for moves and a release to follow. */
export function grab(handle: Element): Grab {
  pointerEvent(handle, 'pointerdown');
  return {
    to: (x, y) => {
      pointerEvent(handle, 'pointermove', x, y);
    },
    release: (end = 'pointerup') => {
      pointerEvent(handle, end);
    },
  };
}

/** Drags `handle` through `moves`, then ends the drag with `end`. */
export function drag(
  handle: Element,
  moves: readonly { x: number; y: number }[],
  end: 'pointerup' | 'pointercancel' = 'pointerup',
): void {
  const held = grab(handle);
  for (const { x, y } of moves) {
    held.to(x, y);
  }
  held.release(end);
}

/** A pointer move over `target` with no button held. */
export function hover(target: Element, type: 'pointerover' | 'pointermove' | 'pointerleave', x = 0, y = 0): void {
  pointerEvent(target, type, x, y);
}

/** Counts the mutations under `target` from now on, both those delivered and those still queued. */
export function countMutations(target: Node, options: MutationObserverInit): { count: () => number; stop: () => void } {
  let seen = 0;
  const observer = new MutationObserver(records => {
    seen += records.length;
  });
  observer.observe(target, options);
  return {
    count: () => {
      seen += observer.takeRecords().length;
      return seen;
    },
    stop: () => {
      observer.disconnect();
    },
  };
}
