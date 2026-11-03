// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The debug panel as the host mounts it, on a bus of the story's own, with page effects and the panel's computations
// counted. Plays reach the mounted panel and the bus through `getDebugPanel()`.

import type { SolidRenderer } from 'storybook-solidjs-vite';
import type { StoryContext } from 'storybook/internal/types';
import { expect, fn, waitFor } from 'storybook/test';
import { createDebugBus } from '@dotli/truapi-debug/testing';
import { fakeDebugPanelHost } from '../../host.fake.js';
import type { KeyedSignals } from '../../createKeyedSignals.js';
import { setupTruapiDebugPanel } from '../../truapiDebugPanel.js';
import { dockStorage } from '../../model/createDockStorage.js';
import { sectionStorage } from '../../model/createSectionStorage.js';
import { NARROW_QUERY, PANEL_ID } from '../../Panel.js';
import type { PanelEffects } from '../../panelEffects.js';
import { panelWork, type PanelWork } from '../../panelWork.js';
import { buildSystemEvent, type BuildSystemEventParams } from '../buildSystemEvent.js';
import { buildTruapiEvent, type BuildTruapiEventParams } from '../buildTruapiEvent.js';

/** How often each of the panel's repeated computations ran. */
export type WorkCalls = ReturnType<typeof createWorkCalls>;

/** The story's panel harness: its bus, host page, page effects and counted computations. */
export type DebugPanelStory = ReturnType<typeof createDebugPanelStory>;

/** How a story mounts the panel, as its `debugPanel` parameter. */
export type DebugPanelParameters = {
  /** False leaves the mount to the play, as for one on fake timers. */
  mount?: boolean;
  capacity?: number;
  startCollapsed?: boolean;
};

/** A pointer pressed on an element, held until released. */
export type HeldPointer = {
  /** Moves the held pointer to `x`, `y`. Never throws. */
  moveTo: (x: number, y: number) => void;
  /** Lets go with `end`, a pointer up unless it says otherwise. Never throws. */
  release: (params?: { end?: 'pointerup' | 'pointercancel' }) => void;
};

/** A count of the mutations under an element, kept until disposed. */
export type MutationCounter = {
  /** The mutations seen so far, the queued ones taken in. Never throws. */
  count: () => number;
  /** Stops counting. Never throws. */
  dispose: () => void;
};

/** Fake time for a play. */
export type FakeClock = {
  /** Lets one animation frame pass, so a scheduled render runs. */
  passFrame: () => void;
  advance: (ms: number) => void;
  /** Timers scheduled and not yet run. */
  timerCount: () => number;
};

type CountingWorkParams = {
  real: PanelWork;
  calls: WorkCalls;
  keyedMaps: KeyedSignals<unknown, unknown>[];
};

type SystemParams = {
  layer: string;
  event: string;
  flowId: string;
  payload?: Record<string, unknown>;
};

type PointerParams = {
  type: string;
  x?: number;
  y?: number;
};

/** Where the story page's content starts, in px, below a bar the page does not draw. */
export const CONTENT_TOP = 52;

let current: DebugPanelStory | undefined;

/** The story's panel harness, set up by `setUpDebugPanel`. Throws when no story set one up. */
export function getDebugPanel(): DebugPanelStory {
  if (current === undefined) {
    throw new Error('The story has no debug panel harness');
  }
  return current;
}

/**
 * The stories' `beforeEach`: a buffering bus, the panel's stored choices cleared, and the panel mounted as the
 * `debugPanel` parameter says. Returns the cleanup.
 */
export function setUpDebugPanel(context: { parameters: { debugPanel?: DebugPanelParameters } }): () => void {
  const options = context.parameters.debugPanel ?? {};
  resetStoredChoices();
  const story = createDebugPanelStory();
  current = story;
  if (options.mount !== false) {
    story.mount({ capacity: options.capacity, startCollapsed: options.startCollapsed });
  }
  return () => {
    story.disposeMounts();
    current = undefined;
    resetStoredChoices();
  };
}

/** Puts the panel's dock and tab back to their defaults, which removes their keys. */
function resetStoredChoices(): void {
  // Resets the panel's own two choices alone, not every store a story's host fakes hold. The page atoms outlive a
  // story, so clearing the keys alone would carry a choice over.
  dockStorage.set('bottom');
  sectionStorage.set('truapi');
}

/** The mounted panel. Throws when it is not mounted. */
export function getPanel(): HTMLElement {
  const element = document.getElementById(PANEL_ID);
  if (element === null) {
    throw new Error('The debug panel is not mounted');
  }
  return element;
}

/** The panel's element with `data-testid` `id`, and `value` as its `data-value` when given. Throws when none matches. */
export function getPart(id: string, { value }: { value?: string } = {}): HTMLElement {
  const selector = value === undefined ? `[data-testid="${id}"]` : `[data-testid="${id}"][data-value="${value}"]`;
  const element = getPanel().querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`No ${selector} in the debug panel`);
  }
  return element;
}

/** The list view's rows, top to bottom. Throws when the panel is not mounted. */
export function listRows(): HTMLElement[] {
  return [...getPanel().querySelectorAll<HTMLElement>('[data-testid="td-list"] [data-testid="td-row"]')];
}

/** The tag a row shows, or an empty string when it shows none. Never throws. */
export function readRowTag(row: HTMLElement): string {
  return row.querySelector('[data-testid="td-tag"]')?.textContent ?? '';
}

/** The tag of each list row, top to bottom. Throws when the panel is not mounted. */
export function listRowTags(): string[] {
  return listRows().map(readRowTag);
}

/** The first list row showing `tag`. Throws when there is none. */
export function getRowByTag(tag: string): HTMLElement {
  const row = listRows().find(r => readRowTag(r) === tag);
  if (row === undefined) {
    throw new Error(`No row tagged ${tag}`);
  }
  return row;
}

/** The header's event counts as shown. Throws when the panel is not mounted. */
export function readCounts(): string {
  return getPart('td-counts').textContent;
}

/** The detail pane's head as name and value. Throws when no detail pane is open. */
export function readDetailRows(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const term of getPart('td-detail-head').querySelectorAll('dt')) {
    entries[term.textContent] = term.nextElementSibling?.textContent ?? '';
  }
  return entries;
}

/** The tag of each selected list row, top to bottom. Throws when the panel is not mounted. */
export function listSelectedTags(): string[] {
  return listRows()
    .filter(r => r.getAttribute('data-selection') === 'selected')
    .map(readRowTag);
}

/** The timeline box whose tooltip mentions `text`. Throws when there is none. */
export function getTimelineBox(text: string): SVGRectElement {
  const box = [
    ...getPanel().querySelectorAll<SVGRectElement>('[data-testid="td-timeline"] [data-testid="td-tl-segment"]'),
  ].find(r => r.getAttribute('data-tooltip')?.includes(text) === true);
  if (box === undefined) {
    throw new Error(`No timeline box for ${text}`);
  }
  return box;
}

/** The Resolution view's fact named `name`, or an empty string when it shows none. Throws when the panel is not mounted. */
export function getResolutionFact(name: string): string {
  return (
    getPanel().querySelector(`[data-testid="td-res"] [data-testid="td-res-fact"][data-fact="${name}"] dd`)
      ?.textContent ?? ''
  );
}

/** A handshake request, its response `advance` lets 50 ms pass before, and a host boot event. */
export function seedMixedTraffic({ advance = () => undefined }: { advance?: (ms: number) => void } = {}): void {
  const { emitTruapi, emitSystem } = getDebugPanel();
  emitTruapi({
    tag: 'system_handshake_request',
    requestId: 'req-aaa-111',
    direction: 'outgoing',
    value: { version: 1 },
  });
  advance(50);
  emitTruapi({
    tag: 'system_handshake_response',
    requestId: 'req-aaa-111',
    direction: 'incoming',
    value: { ok: true },
  });
  emitSystem({
    layer: 'boot',
    event: 'started',
    flowId: 'flow-boot-1',
    payload: { chainBackend: 'smoldot', mode: 'direct', contentBackend: 'helia' },
  });
}

/** Seeds the mixed traffic and resolves once its three rows have rendered. Rejects when they never do. */
export async function showMixedTraffic(): Promise<void> {
  seedMixedTraffic();
  await waitFor(() => expect(listRows()).toHaveLength(3));
}

/** Seeds the filter traffic and resolves once its five rows have rendered. Rejects when they never do. */
export async function showFilterTraffic(): Promise<void> {
  seedFilterTraffic();
  await waitFor(() => expect(listRows()).toHaveLength(5));
}

/**
 * Runs `play` on vitest's fake timers, from a fixed moment on the 16 ms animation-frame grid, so time-driven rows,
 * badges and ticks are exact. Only under the vitest runner, as the workshop has no fake timers. Rejects with what
 * `play` rejects with.
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
      passFrame: () => {
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

/** Presses the pointer on `handle`, for moves and a release to follow. Never throws. */
export function grab(handle: Element): HeldPointer {
  dispatchPointer(handle, { type: 'pointerdown' });
  return {
    moveTo(x: number, y: number): void {
      dispatchPointer(handle, { type: 'pointermove', x, y });
    },
    release({ end = 'pointerup' }: { end?: 'pointerup' | 'pointercancel' } = {}): void {
      dispatchPointer(handle, { type: end });
    },
  };
}

/** Drags `handle` through `moves`, then ends the drag with `end`. Never throws. */
export function drag(
  handle: Element,
  { moves, end = 'pointerup' }: { moves: readonly { x: number; y: number }[]; end?: 'pointerup' | 'pointercancel' },
): void {
  const held = grab(handle);
  for (const { x, y } of moves) {
    held.moveTo(x, y);
  }
  held.release({ end });
}

/** A pointer move over `target` with no button held. Never throws. */
export function hover(
  target: Element,
  params: PointerParams & { type: 'pointerover' | 'pointermove' | 'pointerleave' },
): void {
  dispatchPointer(target, params);
}

/** Counts the mutations under `target` from now on, both those delivered and those still queued. Never throws. */
export function countMutations(target: Node, options: MutationObserverInit): MutationCounter {
  let seen = 0;
  const observer = new MutationObserver(records => {
    seen += records.length;
  });
  observer.observe(target, options);
  return {
    count(): number {
      seen += observer.takeRecords().length;
      return seen;
    },
    dispose(): void {
      observer.disconnect();
    },
  };
}

function createWorkCalls() {
  return {
    matchesFilters: 0,
    formatPending: 0,
    getRowSelection: 0,
    buildTimeline: 0,
    buildResolution: 0,
  };
}

function createDebugPanelStory() {
  const bus = createDebugBus();
  bus.enableBuffering();
  const calls = createWorkCalls();
  const keyedMaps: KeyedSignals<unknown, unknown>[] = [];
  const work = createCountingWork({ real: panelWork, calls, keyedMaps });
  const effects = {
    writeClipboard: fn<PanelEffects['writeClipboard']>(() => Promise.resolve()),
    download: fn<PanelEffects['download']>(),
  };
  const disposers: (() => void)[] = [];
  const host = fakeDebugPanelHost({ contentInsets: { top: `${String(CONTENT_TOP)}px`, bottom: '0px' } });
  return {
    bus,
    /** The host page the panel reads, which a play sets. */
    host,
    effects,
    calls,
    /** The per-row signal maps the panel made, to see which keys it still holds. */
    keyedMaps,
    /** Mounts the panel and returns its dispose. The story ends with it disposed. Never throws. */
    mount,
    /** Emits a TrUAPI message on the bus. Never throws. */
    emitTruapi,
    /**
     * Emits a host event on the bus, stamped with the page clock. The payload may hold fields the event union does not
     * name. Never throws.
     */
    emitSystem,
    /** Zeroes `calls`, so a play counts only what follows. Never throws. */
    resetCalls,
    /** Disposes every panel the story mounted. Never throws. */
    disposeMounts,
  };

  function mount(options: { capacity?: number | undefined; startCollapsed?: boolean | undefined } = {}): () => void {
    const dispose = setupTruapiDebugPanel({
      host: host.host,
      bus,
      effects,
      work,
      ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
      ...(options.startCollapsed === undefined ? {} : { startCollapsed: options.startCollapsed }),
    });
    disposers.push(dispose);
    return dispose;
  }

  function emitTruapi(params: BuildTruapiEventParams): void {
    bus.emit(buildTruapiEvent(params));
  }

  function emitSystem({ payload = {}, ...step }: SystemParams): void {
    // A story also sends payloads older hosts sent, such as boot's `mode`, which the event union does not name.
    const params = { ...step, payload, timestamp: Date.now() } as BuildSystemEventParams;
    bus.emit(buildSystemEvent(params));
  }

  function resetCalls(): void {
    Object.assign(calls, createWorkCalls());
  }

  function disposeMounts(): void {
    for (const dispose of disposers) {
      dispose();
    }
  }
}

/** `real` with each computation counted. CAUTION: writes into `calls` and adds each keyed map it builds to `keyedMaps`. */
function createCountingWork({ real, calls, keyedMaps }: CountingWorkParams): PanelWork {
  return {
    matchesFilters(...args) {
      calls.matchesFilters++;
      return real.matchesFilters(...args);
    },
    formatPending(...args) {
      calls.formatPending++;
      return real.formatPending(...args);
    },
    getRowSelection(...args) {
      calls.getRowSelection++;
      return real.getRowSelection(...args);
    },
    buildTimeline(...args) {
      calls.buildTimeline++;
      return real.buildTimeline(...args);
    },
    buildResolution(...args) {
      calls.buildResolution++;
      return real.buildResolution(...args);
    },
    createKeyedSignals<Key, Value>() {
      const map = real.createKeyedSignals<Key, Value>();
      keyedMaps.push(map);
      return map;
    },
  };
}

/** Two products, an event without a product and a host boot event. */
function seedFilterTraffic(): void {
  const { emitTruapi, emitSystem } = getDebugPanel();
  emitTruapi({ tag: 'alpha_request', requestId: 'a1', productId: 'b.dot', direction: 'outgoing' });
  emitTruapi({ tag: 'alpha_response', requestId: 'a1', productId: 'b.dot', direction: 'incoming' });
  emitTruapi({ tag: 'beta_request', requestId: 'b1', productId: 'a.dot', direction: 'incoming' });
  emitTruapi({ tag: 'gamma_request', requestId: 'c1', productId: null, direction: 'outgoing' });
  emitSystem({ layer: 'boot', event: 'started', flowId: 'flow-1', payload: { chainBackend: 'smoldot' } });
}

function dispatchPointer(target: Element, { type, x = 0, y = 0 }: PointerParams): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: y }));
}
