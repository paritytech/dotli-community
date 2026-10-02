// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Characterization suite for the TrUAPI debug panel.
//
// Pins what a developer (or the host page) observes today: markup, classes,
// text, storage writes, iframe geometry, clipboard and download calls, and
// row node identity under streaming load. The panel is obtained only through
// `loadPanel()` so the same suite runs unchanged against a re-implementation.
//
// The bus and the panel keep module state, so every test resets the module
// registry and imports both afresh (they then share one bus instance). Fake
// timers drive `requestAnimationFrame`, the 1 s pending tick and the 500 ms
// resolution tick.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPanel, type PanelModule } from './panel-entry.js';
import type * as DotliDebugBusModule from '../../../truapi-debug/src/dotli-debug-bus.js';
import type * as ProductFrameLayoutModule from '../../src/product-frame-layout.js';
import type * as TopbarStateModule from '../../src/state/topbar.js';
import { byTestId, query, must } from '../support.js';
import { nth } from '../helpers/nth.js';

type Bus = typeof DotliDebugBusModule;
type BusEvent = Parameters<Bus['emitDotliDebugEvent']>[0];
type SetupOptions = Parameters<PanelModule['setupTruapiDebugPanel']>[0];

const PANEL_ID = 'truapi-debug-panel';

let bus: Bus;
let layout: typeof ProductFrameLayoutModule;
let topbarState: typeof TopbarStateModule;
let panelModule: PanelModule;
let disposers: (() => void)[] = [];

beforeEach(async () => {
  // Starting the fake clock at a fixed time keeps the 16 ms animation-frame
  // grid aligned with it, so frame timings are reproducible.
  vi.useFakeTimers({ now: new Date(2026, 8, 25, 12, 34, 56, 789) });
  vi.resetModules();
  document.head.replaceChildren();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  bus = await import('../../../truapi-debug/src/dotli-debug-bus.js');
  // Imported after the reset so the panel reports to this same instance.
  layout = await import('../../src/product-frame-layout.js');
  topbarState = await import('../../src/state/topbar.js');
  panelModule = await loadPanel();
  // As `apps/host/src/main.ts` does once it decides the panel will mount.
  bus.enableDotliDebugBuffering();
});

afterEach(() => {
  for (const dispose of disposers) {
    dispose();
  }
  disposers = [];
  // happy-dom's default; a test that narrows the viewport must not leak it.
  setViewportWidth(1024);
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

// Helpers

function mount(options?: SetupOptions): () => void {
  const dispose = panelModule.setupTruapiDebugPanel(options);
  disposers.push(dispose);
  return dispose;
}

function panelOrNull(): HTMLElement | null {
  return document.getElementById(PANEL_ID);
}

function panel(): HTMLElement {
  const el = panelOrNull();
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
  return rows().map(r => byTestId('td-tag', r).textContent);
}

function rowByTag(tag: string): HTMLElement {
  const row = rows().find(r => byTestId('td-tag', r).textContent === tag);
  if (row === undefined) {
    throw new Error(`no row tagged ${tag}`);
  }
  return row;
}

function counts(): string {
  return q('[data-testid="td-counts"]').textContent;
}

/** Let one animation frame pass, so a scheduled render runs. */
function frame(): void {
  vi.advanceTimersByTime(20);
}

interface TruapiInput {
  tag: string;
  requestId: string;
  direction?: 'incoming' | 'outgoing';
  /** `null` emits an event without a product id. */
  productId?: string | null;
  value?: unknown;
}

function truapi(input: TruapiInput): void {
  bus.emitDotliDebugEvent({
    kind: 'truapi',
    direction: input.direction ?? 'outgoing',
    ...(input.productId !== null ? { productId: input.productId ?? 'app.dot' } : {}),
    requestId: input.requestId,
    payload: { tag: input.tag, value: input.value ?? {} },
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

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function key(el: Element, name: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function toggle(checkbox: HTMLInputElement): void {
  checkbox.checked = !checkbox.checked;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Resize the viewport as a phone or a rotation does; media queries follow. */
function setViewportWidth(width: number): void {
  (window as unknown as { happyDOM: { setViewport: (viewport: { width: number }) => void } }).happyDOM.setViewport({
    width,
  });
}

function pointer(target: EventTarget, type: string, x = 0, y = 0): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      pointerId: 1,
      clientX: x,
      clientY: y,
    }),
  );
}

function detailRows(): Record<string, string> {
  const out: Record<string, string> = {};
  const head = q('[data-testid="td-detail-head"]');
  for (const dt of head.querySelectorAll('dt')) {
    out[dt.textContent] = dt.nextElementSibling?.textContent ?? '';
  }
  return out;
}

function selectedRows(): HTMLElement[] {
  return rows().filter(r => r.getAttribute('data-selection') === 'selected');
}

function tab(view: 'list' | 'timeline' | 'resolution' | 'archive'): HTMLElement {
  return q(`[data-testid="td-tab"][data-view="${view}"]`);
}

function resolutionFact(name: string): string {
  return query(panel(), `[data-testid="td-res"] [data-testid="td-res-fact"][data-fact="${name}"] dd`).textContent;
}

/** happy-dom lays nothing out: give the panel element a box. */
function stubPanelBox(width: number, height: number): void {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.id === PANEL_ID ? width : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.id === PANEL_ID ? height : 0;
  });
}

/**
 * Hand the frame layout a stand-in product frame that records each style
 * declaration as written. happy-dom's CSS parser discards a `calc()` holding
 * a `var()`, so a real iframe would read back empty inset-aware values.
 */
function attachFrame(withTopbar: boolean): Record<string, string> {
  if (withTopbar) {
    topbarState.setTopbarPresent();
  }
  const style: Record<string, string> = {};
  layout.attachProductFrame({ style } as unknown as HTMLIFrameElement);
  return style;
}

const SAFE_WIDTH = 'calc(100% - var(--safe-left, 0px) - var(--safe-right, 0px))';
const BELOW_BAR_HEIGHT = 'calc(100dvh - var(--topbar-height, 56px) - var(--safe-bottom, 0px))';
const FULL_HEIGHT = 'calc(100dvh - var(--safe-top, 0px) - var(--safe-bottom, 0px))';

function stubClipboard(writeText: ((text: string) => Promise<void>) | null): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText === null ? undefined : { writeText },
  });
}

function restoreClipboard(): void {
  delete (navigator as { clipboard?: unknown }).clipboard;
}

/** A request/response pair plus one system event, one frame apart. */
/** The timeline box whose tooltip mentions `text`. */
function timelineBox(text: string): SVGRectElement {
  const box = [
    ...panel().querySelectorAll<SVGRectElement>('[data-testid="td-timeline"] [data-testid="td-tl-segment"]'),
  ].find(r => r.getAttribute('data-tooltip')?.includes(text) === true);
  if (box === undefined) {
    throw new Error(`no timeline box for ${text}`);
  }
  return box;
}

function seedMixedTraffic(): void {
  truapi({
    tag: 'system_handshake_request',
    requestId: 'req-aaa-111',
    direction: 'outgoing',
    value: { version: 1 },
  });
  vi.advanceTimersByTime(50);
  truapi({
    tag: 'system_handshake_response',
    requestId: 'req-aaa-111',
    direction: 'incoming',
    value: { ok: true },
  });
  system('boot', 'started', 'flow-boot-1', {
    chainBackend: 'smoldot',
    mode: 'direct',
    contentBackend: 'helia',
  });
  frame();
}

// Tests

describe('truapi debug panel: mount and dispose', () => {
  it('As a dotli developer, mounting shows the header controls, filters, tabs, views and detail pane', () => {
    // When
    mount();

    // Then
    const root = panel();
    expect(root.hasAttribute('data-collapsed')).toBe(false);
    expect(root.getAttribute('data-dock')).toBe('bottom');
    expect(root.querySelector('[data-testid="td-resize-handle"]')).not.toBeNull();
    expect(q('[data-testid="td-header"] [data-testid="td-title"]').textContent).toBe('TrUAPI Debug');
    expect(counts()).toBe('0 events');
    expect(q('[data-testid="td-pause"]').textContent).toBe('Pause');
    expect(q('[data-testid="td-clear"]').textContent).toBe('Clear');
    expect(q('[data-testid="td-export"]').title).toBe('Download as JSON');
    expect(q('[data-testid="td-export"]').getAttribute('aria-label')).toBe('Download as JSON');
    expect(q('[data-testid="td-export"]').querySelector('svg')).not.toBeNull();
    expect(q('[data-testid="td-copy"]').title).toBe('Copy to clipboard');
    expect(q('[data-testid="td-copy"]').getAttribute('aria-label')).toBe('Copy to clipboard');
    expect(q('[data-testid="td-copy"]').querySelector('svg')).not.toBeNull();
    expect(q('[data-testid="td-dock"]').title).toBe('Dock to right');
    expect(q('[data-testid="td-dock"]').getAttribute('aria-label')).toBe('Dock to right');
    expect(q('[data-testid="td-dock"]').querySelector('svg')).not.toBeNull();
    expect(q('[data-testid="td-collapse"]').textContent).toBe('▼');
    expect(q('[data-testid="td-collapse"]').title).toBe('Collapse');
    expect(q('[data-testid="td-close"]').textContent).toBe('×');
    expect(q('[data-testid="td-close"]').title).toBe('Hide (Ctrl+Shift+D)');

    const kinds = [
      ...root.querySelectorAll<HTMLInputElement>('[data-testid="td-filters"] input[data-testid="td-kind"]'),
    ];
    expect(kinds.map(k => [k.dataset['kind'], k.checked])).toEqual([
      ['truapi', true],
      ['system', true],
    ]);
    const dirs = [...root.querySelectorAll<HTMLElement>('[data-testid="td-dir"]')];
    expect(dirs.map(d => d.textContent)).toEqual(['both', '▶ out', '◀ in']);
    expect(dirs.map(d => d.hasAttribute('data-active'))).toEqual([true, false, false]);
    const chips = [...root.querySelectorAll<HTMLElement>('[data-testid="td-product-chip"]')];
    expect(chips.map(c => c.textContent)).toEqual(['all']);
    expect(chips[0]?.hasAttribute('data-active')).toBe(true);
    expect(byTestId('td-tag-input', panel(), HTMLInputElement).placeholder).toBe('filter by method…');
    expect(byTestId('td-exclude-input', panel(), HTMLInputElement).placeholder).toBe('hide by method…');

    const tabs = [...root.querySelectorAll<HTMLElement>('[data-testid="td-tabs"] [data-testid="td-tab"]')];
    expect(tabs.map(t => t.textContent)).toEqual(['List', 'Timeline', 'Resolution', 'Archive']);
    expect(tabs.map(t => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    expect(q('[data-testid="td-list"]').hidden).toBe(false);
    expect(q('[data-testid="td-list"] [data-testid="td-empty"]').textContent).toBe(
      'No events match the current filter.',
    );
    expect(q('[data-testid="td-timeline"]').hidden).toBe(true);
    expect(q('[data-testid="td-res"]').hidden).toBe(true);
    expect(q('[data-testid="td-archive"]').hidden).toBe(true);
    expect(root.querySelector('[data-testid="td-body-splitter"]')).not.toBeNull();
    expect(q('[data-testid="td-detail-empty"]').textContent).toBe(
      'Select an event on the left to inspect its payload.',
    );
    expect(root.querySelector('[data-testid="td-tooltip"]')).not.toBeNull();
  });

  it('As a dotli developer, a second setup while mounted is a no-op', () => {
    // Given
    mount();
    truapi({ tag: 'a_request', requestId: 'r1' });
    frame();

    // When
    const secondDispose = mount();
    secondDispose();

    // Then
    expect(document.querySelectorAll(`#${PANEL_ID}`)).toHaveLength(1);
    expect(rows()).toHaveLength(1);
    expect(counts()).toBe('1 events');
  });

  it('As a dotli developer, startCollapsed mounts the panel header-only', () => {
    // When
    mount({ startCollapsed: true });

    // Then
    expect(panel().hasAttribute('data-collapsed')).toBe(true);
    expect(q('[data-testid="td-collapse"]').textContent).toBe('▲');
    expect(q('[data-testid="td-resize-handle"]').hasAttribute('data-collapsed')).toBe(true);
    expect(q('[data-testid="td-filters"]').hasAttribute('data-collapsed')).toBe(true);
  });

  it('As a dotli developer, dispose removes the panel and stops every timer and subscription', () => {
    // Given
    const dispose = mount();
    truapi({ tag: 'a_request', requestId: 'r1' });
    frame();

    // When
    dispose();

    // Then
    expect(panelOrNull()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    truapi({ tag: 'b_request', requestId: 'r2' });
    expect(vi.getTimerCount()).toBe(0);
    expect(bus.hasDotliDebugListeners()).toBe(false);
  });
});

describe('truapi debug panel: event rows', () => {
  it('As a dotli developer, TrUAPI messages appear as rows with arrow, product, request id, tag, summary and latency', () => {
    // Given
    mount();

    // When
    seedMixedTraffic();
    truapi({
      tag: 'chat_subscribe',
      requestId: 'sub-1',
      productId: null,
      direction: 'incoming',
      value: 'hello',
    });
    truapi({ tag: 'plain_tag', requestId: 'p-1' });
    frame();

    // Then
    expect(counts()).toBe('5 events');
    const request = rowByTag('system_handshake_request');
    expect(request.hasAttribute('data-system')).toBe(false);
    expect(request.getAttribute('role')).toBe('listitem');
    expect(byTestId('td-time', request).textContent).toBe('12:34:56.789');
    expect(byTestId('td-arrow-out', request).textContent).toBe('▶');
    expect(request.querySelector('[data-testid="td-arrow-in"]')).toBeNull();
    expect(byTestId('td-product', request).textContent).toBe('app.dot');
    expect(byTestId('td-product', request).hasAttribute('data-anon')).toBe(false);
    expect(byTestId('td-rid', request).textContent).toBe('req-aa');
    const reqTag = byTestId('td-tag', request);
    expect(reqTag.getAttribute('data-kind')).toBe('request');
    expect(byTestId('td-summary', request).textContent).toBe('version=1');
    expect(request.querySelector('[data-testid="td-latency"]')).toBeNull();

    const response = rowByTag('system_handshake_response');
    expect(byTestId('td-arrow-in', response).textContent).toBe('◀');
    expect(byTestId('td-tag', response).getAttribute('data-kind')).toBe('response');
    expect(byTestId('td-latency', response).textContent).toBe('+50ms');
    expect(byTestId('td-summary', response).textContent).toBe('ok=true');

    const anon = rowByTag('chat_subscribe');
    expect(byTestId('td-product', anon).textContent).toBe('(no id)');
    expect(byTestId('td-product', anon).hasAttribute('data-anon')).toBe(true);
    expect(byTestId('td-tag', anon).getAttribute('data-kind')).toBe('subscription');
    expect(byTestId('td-summary', anon).textContent).toBe('hello');

    expect(byTestId('td-tag', rowByTag('plain_tag')).getAttribute('data-kind')).toBe('plain');
    // An empty payload has no summary span.
    expect(rowByTag('plain_tag').querySelector('[data-testid="td-summary"]')).toBeNull();
  });

  it('As a dotli developer, system events appear as rows with layer badge, flow id, layer.event and summary', () => {
    // Given
    mount();

    // When
    seedMixedTraffic();

    // Then
    const row = rowByTag('boot.started');
    expect(row.hasAttribute('data-system')).toBe(true);
    expect(byTestId('td-layer-badge', row).getAttribute('data-layer')).toBe('boot');
    expect(byTestId('td-layer-badge', row).textContent).toBe('boot');
    expect(byTestId('td-rid', row).textContent).toBe('flow-b');
    expect(byTestId('td-tag', row).getAttribute('data-kind')).toBe('system');
    expect(byTestId('td-summary', row).textContent).toBe(
      'Host boot started (mode: direct, chain: smoldot, content: helia).',
    );
    expect(row.querySelector('[data-testid="td-arrow-out"], [data-testid="td-arrow-in"]')).toBeNull();
  });

  it('As a dotli developer, chain messages show their decoded method label instead of the raw tag', () => {
    // Given
    mount();

    // When
    truapi({
      tag: 'remote_chain_head_follow_start',
      requestId: 'follow-1',
      value: { genesisHash: '0x' + 'ab'.repeat(32), withRuntime: true },
    });
    frame();

    // Then
    const tag = byTestId('td-tag', nth(rows(), 0));
    expect(tag.textContent).toBe('chainHead.follow');
    expect(tag.getAttribute('data-kind')).toBe('request');
  });

  it('As a dotli developer, a selected chain response shows its summary and its decoded annotations', () => {
    // Given
    mount();
    truapi({
      tag: 'remote_chain_head_header_response',
      requestId: 'header-1',
      direction: 'incoming',
      value: { tag: 'V1', value: { success: false, value: { reason: 'block not pinned' } } },
    });
    frame();

    // When
    click(nth(rows(), 0));

    // Then
    expect(q('[data-testid="td-detail-summary"]').textContent).toBe('Header fetch failed: block not pinned.');
    const chain = q('[data-testid="td-chain-head"]');
    expect([...chain.querySelectorAll('dt')].map(dt => dt.textContent)).toEqual(['method', 'outcome']);
    expect([...chain.querySelectorAll('dd')].map(dd => dd.textContent)).toEqual([
      'chainHead.header',
      'error: block not pinned',
    ]);
  });

  it('As a dotli developer, events emitted after buffering is enabled but before the panel mounts are shown', () => {
    // Given the bus is buffering (beforeEach) and nothing listens yet
    system('boot', 'started', 'flow-early', { chainBackend: 'smoldot' });
    truapi({ tag: 'early_request', requestId: 'early-1' });

    // When
    mount();
    frame();

    // Then
    expect(rowTags()).toEqual(['boot.started', 'early_request']);
    expect(counts()).toBe('2 events');
  });
});

describe('truapi debug panel: header actions', () => {
  it('As a dotli developer, Pause stops new rows until Resume', () => {
    // Given
    mount();
    truapi({ tag: 'before_request', requestId: 'r1' });
    frame();

    // When
    click(q('[data-testid="td-pause"]'));
    truapi({ tag: 'while_paused_request', requestId: 'r2' });
    frame();

    // Then
    expect(q('[data-testid="td-pause"]').textContent).toBe('Resume');
    expect(q('[data-testid="td-pause"]').hasAttribute('data-active')).toBe(true);
    expect(rowTags()).toEqual(['before_request']);
    expect(counts()).toBe('1 events');

    // When
    click(q('[data-testid="td-pause"]'));
    truapi({ tag: 'after_request', requestId: 'r3' });
    frame();

    // Then
    expect(q('[data-testid="td-pause"]').textContent).toBe('Pause');
    expect(q('[data-testid="td-pause"]').hasAttribute('data-active')).toBe(false);
    expect(rowTags()).toEqual(['before_request', 'after_request']);
  });

  it('As a dotli developer, system events emitted while paused do not reach the Resolution view', () => {
    // Given
    mount();
    click(q('[data-testid="td-pause"]'));

    // When
    system('boot', 'started', 'flow-boot', { chainBackend: 'smoldot' });
    system('resolve', 'started', 'flow-res', {
      label: 'myapp',
      source: 'smoldot',
    });
    click(q('[data-testid="td-pause"]'));
    click(tab('resolution'));
    frame();

    // Then
    expect(q('[data-testid="td-res"] [data-testid="td-res-empty"]').textContent).toBe(
      'No page load recorded yet. Reload the page with the panel open.',
    );
    expect(panel().querySelector('[data-testid="td-res-summary"]')).toBeNull();
  });

  it('As a dotli developer, Clear empties the list, the counts, the selection and the Resolution view', () => {
    // Given
    mount({ capacity: 2 });
    seedMixedTraffic();
    click(nth(rows(), 0));
    expect(counts()).toBe('2 events (+1 dropped)');

    // When
    click(q('[data-testid="td-clear"]'));
    frame();

    // Then
    expect(rows()).toHaveLength(0);
    expect(q('[data-testid="td-list"] [data-testid="td-empty"]').textContent).toBe(
      'No events match the current filter.',
    );
    expect(counts()).toBe('0 events');
    expect(q('[data-testid="td-detail-empty"]').textContent).toBe(
      'Select an event on the left to inspect its payload.',
    );
    click(tab('resolution'));
    expect(panel().querySelector('[data-testid="td-res"] [data-testid="td-res-empty"]')).not.toBeNull();
  });

  it('As a dotli developer, Export downloads the filtered events as JSON', async () => {
    // Given
    mount();
    seedMixedTraffic();
    type(byTestId('td-exclude-input', panel(), HTMLInputElement), 'response');
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
      blobs.push(blob as Blob);
      return 'blob:dotli-export';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const downloads: { href: string; download: string; attached: boolean }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({
        href: this.href,
        download: this.download,
        attached: document.body.contains(this),
      });
    });

    // When
    click(q('[data-testid="td-export"]'));

    // Then
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.href).toBe('blob:dotli-export');
    expect(downloads[0]?.download).toMatch(/^dotli-debug-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);
    expect(downloads[0]?.attached).toBe(true);
    expect(document.querySelector('a[download]')).toBeNull();
    expect(blobs[0]?.type).toBe('application/json');
    const exported = JSON.parse(await nth(blobs, 0).text()) as {
      meta: Record<string, unknown>;
      events: { tag?: string; event?: string }[];
    };
    expect(exported.meta).toMatchObject({
      capacity: 2000,
      droppedCount: 0,
      totalEvents: 3,
      exportedEvents: 2,
      url: window.location.href,
      userAgent: navigator.userAgent,
      filters: { excludeQuery: 'response', direction: 'both' },
    });
    expect(exported.events.map(e => e.tag ?? e.event)).toEqual(['system_handshake_request', 'started']);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(revoke).toHaveBeenCalledWith('blob:dotli-export');
  });

  it('As a dotli developer, Copy writes the filtered JSON to the clipboard and flashes a check mark', async () => {
    // Given
    mount();
    seedMixedTraffic();
    toggle(query(panel(), '[data-testid="td-kind"][data-kind="system"]', HTMLInputElement));
    const writeText = vi.fn((_text: string) => Promise.resolve());
    stubClipboard(writeText);
    const copy = byTestId('td-copy', panel(), HTMLButtonElement);

    try {
      // When
      click(copy);

      // Then
      expect(copy.disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(copy.textContent).toBe('✓');
      expect(copy.disabled).toBe(true);
      expect(writeText).toHaveBeenCalledTimes(1);
      const exported = JSON.parse(nth(writeText.mock.calls, 0)[0]) as {
        meta: Record<string, unknown>;
        events: { kind: string }[];
      };
      expect(exported.meta).toMatchObject({
        totalEvents: 3,
        exportedEvents: 2,
        filters: { showSystem: false, showTruapi: true },
      });
      expect(exported.events.map(e => e.kind)).toEqual(['truapi', 'truapi']);

      // When
      await vi.advanceTimersByTimeAsync(1200);

      // Then
      expect(copy.disabled).toBe(false);
      expect(copy.textContent).not.toBe('✓');
      expect(copy.querySelector('svg')).not.toBeNull();
    } finally {
      restoreClipboard();
    }
  });

  it('As a dotli developer, Copy flashes a cross when the clipboard rejects or is unavailable', async () => {
    // Given
    mount();
    seedMixedTraffic();
    const copy = byTestId('td-copy', panel(), HTMLButtonElement);

    try {
      // When the write is rejected
      stubClipboard(() => Promise.reject(new Error('denied')));
      click(copy);
      await vi.advanceTimersByTimeAsync(0);

      // Then
      expect(copy.textContent).toBe('✕');
      await vi.advanceTimersByTimeAsync(1200);
      expect(copy.disabled).toBe(false);
      expect(copy.querySelector('svg')).not.toBeNull();

      // When there is no clipboard at all (non-secure origin)
      stubClipboard(null);
      click(copy);

      // Then
      expect(copy.textContent).toBe('✕');
      expect(copy.disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(1200);
      expect(copy.disabled).toBe(false);
      expect(copy.querySelector('svg')).not.toBeNull();
    } finally {
      restoreClipboard();
    }
  });

  it('As a dotli developer, the close button exits debug mode and reloads', () => {
    // Given
    mount();
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);

    // When
    click(q('[data-testid="td-close"]'));

    // Then
    expect(sessionStorage.getItem('dotli:truapi-debug')).toBe('0');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('truapi debug panel: filters', () => {
  function seedFilterTraffic(): void {
    truapi({
      tag: 'alpha_request',
      requestId: 'a1',
      productId: 'b.dot',
      direction: 'outgoing',
    });
    truapi({
      tag: 'alpha_response',
      requestId: 'a1',
      productId: 'b.dot',
      direction: 'incoming',
    });
    truapi({
      tag: 'beta_request',
      requestId: 'b1',
      productId: 'a.dot',
      direction: 'incoming',
    });
    truapi({
      tag: 'gamma_request',
      requestId: 'c1',
      productId: null,
      direction: 'outgoing',
    });
    system('boot', 'started', 'flow-1', { chainBackend: 'smoldot' });
    frame();
  }

  it('As a dotli developer, the TrUAPI and System checkboxes hide and show their kind', () => {
    // Given
    mount();
    seedFilterTraffic();
    const truapiBox = query(panel(), '[data-testid="td-kind"][data-kind="truapi"]', HTMLInputElement);
    const systemBox = query(panel(), '[data-testid="td-kind"][data-kind="system"]', HTMLInputElement);

    // When
    toggle(truapiBox);

    // Then
    expect(rowTags()).toEqual(['boot.started']);
    expect(counts()).toBe('5 events · 1 shown');

    // When
    toggle(truapiBox);
    toggle(systemBox);

    // Then
    expect(rowTags()).toEqual(['alpha_request', 'alpha_response', 'beta_request', 'gamma_request']);
    expect(counts()).toBe('5 events · 4 shown');

    // When
    toggle(truapiBox);

    // Then
    expect(q('[data-testid="td-list"] [data-testid="td-empty"]').textContent).toBe(
      'No events match the current filter.',
    );
  });

  it('As a dotli developer, direction chips filter TrUAPI rows and leave system rows alone', () => {
    // Given
    mount();
    seedFilterTraffic();

    // When
    click(q('[data-testid="td-dir"][data-dir="outgoing"]'));

    // Then
    expect(rowTags()).toEqual(['alpha_request', 'gamma_request', 'boot.started']);
    expect(q('[data-testid="td-dir"][data-dir="outgoing"]').hasAttribute('data-active')).toBe(true);
    expect(q('[data-testid="td-dir"][data-dir="both"]').hasAttribute('data-active')).toBe(false);

    // When
    click(q('[data-testid="td-dir"][data-dir="incoming"]'));

    // Then
    expect(rowTags()).toEqual(['alpha_response', 'beta_request', 'boot.started']);

    // When
    click(q('[data-testid="td-dir"][data-dir="both"]'));

    // Then
    expect(rows()).toHaveLength(5);
    expect(q('[data-testid="td-dir"][data-dir="both"]').hasAttribute('data-active')).toBe(true);
  });

  it('As a dotli developer, a product chip appears per product id and filters TrUAPI rows to it', () => {
    // Given
    mount();
    seedFilterTraffic();
    const chipTexts = (): string[] =>
      [...panel().querySelectorAll('[data-testid="td-product-chip"]')].map(c => c.textContent);
    const chip = (text: string): HTMLElement => {
      const found = [...panel().querySelectorAll<HTMLElement>('[data-testid="td-product-chip"]')].find(
        c => c.textContent === text,
      );
      if (found === undefined) {
        throw new Error(`no chip ${text}`);
      }
      return found;
    };

    // Then
    expect(chipTexts()).toEqual(['all', 'a.dot', 'b.dot', '(no id)']);

    // When
    click(chip('b.dot'));

    // Then
    expect(rowTags()).toEqual(['alpha_request', 'alpha_response', 'boot.started']);
    expect(chip('b.dot').hasAttribute('data-active')).toBe(true);
    expect(chip('all').hasAttribute('data-active')).toBe(false);

    // When
    click(chip('(no id)'));

    // Then
    expect(rowTags()).toEqual(['gamma_request', 'boot.started']);
    expect(chip('(no id)').hasAttribute('data-active')).toBe(true);

    // When
    click(chip('all'));

    // Then
    expect(rows()).toHaveLength(5);
    expect(chip('all').hasAttribute('data-active')).toBe(true);
  });

  it('As a dotli developer, product chips survive traffic from known products and show markup ids as text', () => {
    // Given
    mount();
    seedFilterTraffic();
    const before = [...panel().querySelectorAll('[data-testid="td-product-chip"]')];

    // When
    truapi({ tag: 'more_request', requestId: 'm1', productId: 'a.dot' });
    frame();

    // Then
    const after = [...panel().querySelectorAll('[data-testid="td-product-chip"]')];
    expect(after).toHaveLength(before.length);
    after.forEach((node, i) => {
      expect(node).toBe(before[i]);
    });

    // When
    truapi({ tag: 'evil_request', requestId: 'e1', productId: '<b>x</b>' });
    frame();

    // Then
    const texts = [...panel().querySelectorAll('[data-testid="td-product-chip"]')].map(c => c.textContent);
    expect(texts).toContain('<b>x</b>');
    expect(panel().querySelector('[data-testid="td-filters"] b')).toBeNull();
    expect(panel().querySelector('[data-testid="td-list"] b')).toBeNull();
  });

  it('As a dotli developer, include and exclude text filters match the tag or layer:event', () => {
    // Given
    mount();
    seedFilterTraffic();
    const include = byTestId('td-tag-input', panel(), HTMLInputElement);
    const exclude = byTestId('td-exclude-input', panel(), HTMLInputElement);

    // When
    type(include, 'ALPHA');

    // Then
    expect(rowTags()).toEqual(['alpha_request', 'alpha_response']);
    expect(counts()).toBe('5 events · 2 shown');

    // When
    type(include, 'boot:start');

    // Then
    expect(rowTags()).toEqual(['boot.started']);

    // When
    type(include, '/^(alpha|beta)_request$/');

    // Then
    expect(rowTags()).toEqual(['alpha_request', 'beta_request']);
    expect(include.getAttribute('aria-invalid')).toBeNull();

    // When the exclude matches too, it wins
    type(exclude, 'beta');

    // Then
    expect(rowTags()).toEqual(['alpha_request']);

    // When an include regex does not parse, it is flagged and inert
    type(include, '/(/');

    // Then
    expect(include.getAttribute('aria-invalid')).toBe('true');
    expect(rowTags()).toEqual(['alpha_request', 'alpha_response', 'gamma_request', 'boot.started']);

    // When
    type(include, '');
    type(exclude, '/[/');

    // Then
    expect(exclude.getAttribute('aria-invalid')).toBe('true');
    expect(rows()).toHaveLength(5);
  });
});

describe('truapi debug panel: selection and detail', () => {
  it('As a dotli developer, clicking a row fills the detail pane and highlights its request group', () => {
    // Given
    mount();
    seedMixedTraffic();

    // When
    click(rowByTag('system_handshake_request'));

    // Then
    expect(document.activeElement).toBe(q('[data-testid="td-list"]'));
    expect(rowByTag('system_handshake_request').getAttribute('data-selection')).toBe('selected');
    expect(rowByTag('system_handshake_response').getAttribute('data-selection')).toBe('paired');
    expect(rowByTag('boot.started').hasAttribute('data-system')).toBe(true);
    expect(rowByTag('boot.started').hasAttribute('data-selection')).toBe(false);
    const detail = detailRows();
    expect(Object.keys(detail)).toEqual(['time', 'direction', 'product', 'tag', 'requestId', 'group']);
    expect(detail['time']).toBe('12:34:56.789');
    expect(detail['direction']).toBe('outgoing');
    expect(detail['product']).toBe('app.dot');
    expect(detail['tag']).toBe('system_handshake_request');
    expect(detail['requestId']).toBe('req-aa req-aaa-111');
    expect(detail['group']).toBe('2 events — system_handshake_response +50ms');
    expect(q('[data-testid="td-detail-pre"]').textContent).toBe(JSON.stringify({ version: 1 }, null, 2));

    // When the sibling pill is clicked
    click(q('[data-testid="td-detail-pair"]'));

    // Then
    expect(rowByTag('system_handshake_response').getAttribute('data-selection')).toBe('selected');
    expect(rowByTag('system_handshake_request').getAttribute('data-selection')).toBe('paired');
    expect(detailRows()['group']).toBe('2 events — system_handshake_request −50ms');

    // When another group is selected
    click(rowByTag('boot.started'));

    // Then
    expect(rowByTag('system_handshake_request').hasAttribute('data-selection')).toBe(false);
    expect(rowByTag('system_handshake_response').hasAttribute('data-selection')).toBe(false);
    expect(selectedRows()).toEqual([rowByTag('boot.started')]);
  });

  it('As a dotli developer, a selected system event shows its summary, a What is this? section and the payload', () => {
    // Given
    mount();
    seedMixedTraffic();

    // When
    click(rowByTag('boot.started'));

    // Then
    const detail = detailRows();
    expect(Object.keys(detail)).toEqual(['time', 'source', 'layer', 'event', 'flowId', 'group']);
    expect(detail['source']).toBe('dotli');
    expect(detail['layer']).toBe('boot');
    expect(detail['event']).toBe('started');
    expect(detail['flowId']).toBe('flow-b flow-boot-1');
    expect(detail['group']).toBe('1 event');
    expect(q('[data-testid="td-detail-section-title"]').textContent).toBe('Summary');
    expect(q('[data-testid="td-detail-summary"]').textContent).toBe(
      'Host boot started (mode: direct, chain: smoldot, content: helia).',
    );
    const explanation = query(panel(), 'details[data-testid="td-detail-explanation"]', HTMLDetailsElement);
    expect(explanation.querySelector('summary')?.textContent).toBe('What is this? — Host boot started');
    expect(explanation.querySelector('code')?.textContent).toBe('main()');
    expect(q('[data-testid="td-detail-pre"]').textContent).toContain('"smoldot"');
  });

  it('As a dotli developer, arrow keys on the list step the selection and clamp at the ends', () => {
    // Given
    mount();
    seedMixedTraffic();
    const list = q('[data-testid="td-list"]');
    const selectedTag = (): string[] => selectedRows().map(r => byTestId('td-tag', r).textContent);

    // When nothing is selected, ArrowDown picks the first row
    key(list, 'ArrowDown');

    // Then
    expect(selectedTag()).toEqual(['system_handshake_request']);
    expect(detailRows()['tag']).toBe('system_handshake_request');

    // When
    key(list, 'ArrowDown');
    key(list, 'ArrowDown');
    key(list, 'ArrowDown');

    // Then it stops on the last row
    expect(selectedTag()).toEqual(['boot.started']);

    // When
    key(list, 'ArrowUp');

    // Then
    expect(selectedTag()).toEqual(['system_handshake_response']);

    // When
    key(list, 'ArrowUp');
    key(list, 'ArrowUp');

    // Then it stops on the first row
    expect(selectedTag()).toEqual(['system_handshake_request']);

    // When other keys are pressed nothing changes
    key(list, 'Enter');
    expect(selectedTag()).toEqual(['system_handshake_request']);
  });

  it('As a dotli developer, ArrowUp with nothing selected picks the last row', () => {
    // Given
    mount();
    seedMixedTraffic();

    // When
    key(q('[data-testid="td-list"]'), 'ArrowUp');

    // Then
    expect(selectedRows()).toEqual([rowByTag('boot.started')]);
  });

  it('As a dotli developer, markup inside a payload shows as text in the row and the detail pane', () => {
    // Given
    mount();
    truapi({
      tag: 'note_request',
      requestId: 'n1',
      value: { note: '<b>bold</b>' },
    });
    frame();

    // When
    click(nth(rows(), 0));

    // Then
    expect(panel().querySelector('b')).toBeNull();
    expect(byTestId('td-summary', nth(rows(), 0)).textContent).toContain('<b>bold</b>');
    expect(q('[data-testid="td-detail-pre"]').textContent).toContain('"note": "<b>bold</b>"');
  });

  it('As a dotli developer, incoming events do not rebuild the detail pane', () => {
    // Given
    mount();
    seedMixedTraffic();
    click(rowByTag('boot.started'));
    const explanation = query(panel(), '[data-testid="td-detail"] details', HTMLDetailsElement);
    explanation.open = true;

    // When
    for (let i = 0; i < 5; i++) {
      system('boot', 'topbar_ready', 'flow-boot-1');
      frame();
    }

    // Then
    expect(q('[data-testid="td-detail"] details')).toBe(explanation);
    expect(explanation.open).toBe(true);
  });

  it('As a dotli developer, the selection survives a filter change', () => {
    // Given
    mount();
    seedMixedTraffic();
    click(rowByTag('system_handshake_request'));

    // When
    type(byTestId('td-tag-input', panel(), HTMLInputElement), 'handshake');

    // Then
    expect(rowByTag('system_handshake_request').getAttribute('data-selection')).toBe('selected');
    expect(rowByTag('system_handshake_response').getAttribute('data-selection')).toBe('paired');
    expect(detailRows()['tag']).toBe('system_handshake_request');
  });
});

describe('truapi debug panel: views', () => {
  it('As a dotli developer, the tabs switch between the list, timeline and resolution views', () => {
    // Given
    mount();
    seedMixedTraffic();

    // When
    click(tab('timeline'));

    // Then
    expect(tab('timeline').getAttribute('aria-selected')).toBe('true');
    expect(tab('list').getAttribute('aria-selected')).toBe('false');
    expect(q('[data-testid="td-list"]').hidden).toBe(true);
    expect(q('[data-testid="td-timeline"]').hidden).toBe(false);
    expect(q('[data-testid="td-res"]').hidden).toBe(true);
    expect(panel().getAttribute('data-view')).toBe('timeline');
    const headers = [
      ...panel().querySelectorAll(
        '[data-testid="td-timeline"] [data-testid="td-sw-col"] [data-testid="td-sw-header-label"]',
      ),
    ].map(h => h.textContent);
    expect(headers).toEqual(['System', 'Other']);
    expect(panel().querySelectorAll('[data-testid="td-timeline"] [data-testid="td-tl-svg"]').length).toBe(2);
    // One box for the request/response pair, one for the boot flow.
    expect(panel().querySelectorAll('[data-testid="td-timeline"] [data-testid="td-tl-segment"]')).toHaveLength(2);

    // When
    click(tab('resolution'));

    // Then
    expect(tab('resolution').getAttribute('aria-selected')).toBe('true');
    expect(q('[data-testid="td-timeline"]').hidden).toBe(true);
    expect(q('[data-testid="td-res"]').hidden).toBe(false);
    expect(panel().getAttribute('data-view')).toBe('resolution');
    expect(q('[data-testid="td-body-splitter"]').hidden).toBe(true);
    expect(q('[data-testid="td-detail"]').hidden).toBe(true);

    // When
    click(tab('list'));

    // Then
    expect(q('[data-testid="td-list"]').hidden).toBe(false);
    expect(q('[data-testid="td-res"]').hidden).toBe(true);
    expect(q('[data-testid="td-detail"]').hidden).toBe(false);
    expect(panel().getAttribute('data-view')).toBe('list');
    expect(rows()).toHaveLength(3);
  });

  it('As a dotli developer, the Archive tab takes the whole width and, with no product, says so', () => {
    // Given
    mount();

    // When
    click(tab('archive'));

    // Then
    expect(tab('archive').getAttribute('aria-selected')).toBe('true');
    expect(q('[data-testid="td-list"]').hidden).toBe(true);
    expect(q('[data-testid="td-archive"]').hidden).toBe(false);
    expect(panel().getAttribute('data-view')).toBe('archive');
    expect(q('[data-testid="td-archive"]').textContent).toContain('No product loaded');

    // When
    click(tab('list'));

    // Then
    expect(q('[data-testid="td-archive"]').hidden).toBe(true);
    expect(panel().getAttribute('data-view')).toBe('list');
  });

  it('As a dotli developer, clicking a timeline box shows its whole group in the detail pane', () => {
    // Given
    mount();
    seedMixedTraffic();
    click(tab('timeline'));
    const box = [
      ...panel().querySelectorAll<SVGRectElement>('[data-testid="td-timeline"] [data-testid="td-tl-segment"]'),
    ].find(r => r.getAttribute('data-tooltip')?.includes('handshake') === true);
    if (box === undefined) {
      throw new Error('no handshake box');
    }

    // When
    click(box);

    // Then
    expect(box.hasAttribute('data-selected')).toBe(true);
    const members = [...panel().querySelectorAll('[data-testid="td-detail-member"]')].map(
      m => byTestId('td-tag', m).textContent,
    );
    expect(members).toEqual(['system_handshake_request', 'system_handshake_response']);
    expect(
      [...panel().querySelectorAll('[data-testid="td-detail-member"] [data-testid="td-tag"]')].map(t =>
        t.getAttribute('data-kind'),
      ),
    ).toEqual(['request', 'response']);
    const head = detailRows();
    expect(head['requestId']).toBe('req-aa req-aaa-111');
    expect(head['group']).toBe('2 events');
    expect(head['duration']).toBe('50ms');
  });

  it('As a dotli developer, new events keep the timeline up to date while it is open', () => {
    // Given
    mount();
    click(tab('timeline'));

    // When
    truapi({ tag: 'late_request', requestId: 'late-1' });
    frame();

    // Then
    expect(panel().querySelectorAll('[data-testid="td-timeline"] [data-testid="td-tl-segment"]')).toHaveLength(1);
  });

  it('As a dotli developer, streaming traffic keeps the hovered timeline box, its tooltip and a click that started on it', () => {
    // Given
    mount();
    seedMixedTraffic();
    click(tab('timeline'));
    const box = timelineBox('handshake');
    const tooltip = q('[data-testid="td-tooltip"]');
    box.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: 30, clientY: 40 }));
    box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

    // When
    for (let i = 0; i < 3; i++) {
      truapi({ tag: 'late_request', requestId: `late-${String(i)}` });
      frame();
    }
    click(box);

    // Then
    expect(timelineBox('handshake')).toBe(box);
    expect(panel().querySelectorAll('[data-testid="td-timeline"] [data-testid="td-tl-segment"]')).toHaveLength(5);
    expect(tooltip.hasAttribute('data-visible')).toBe(true);
    expect(box.hasAttribute('data-selected')).toBe(true);
    expect(detailRows()['group']).toBe('2 events');
  });

  it('As a dotli developer, the selected timeline box follows the selection, and a box shows while it is pending', () => {
    // Given
    mount();
    truapi({ tag: 'first_request', requestId: 'a-1' });
    truapi({ tag: 'second_request', requestId: 'b-1' });
    frame();
    click(tab('timeline'));
    const first = timelineBox('first');
    const second = timelineBox('second');
    expect(first.hasAttribute('data-pending')).toBe(true);

    // When
    click(first);

    // Then
    expect(first.hasAttribute('data-selected')).toBe(true);
    expect(second.hasAttribute('data-selected')).toBe(false);

    // When
    click(second);
    truapi({ tag: 'first_response', requestId: 'a-1', direction: 'incoming' });
    frame();

    // Then
    expect(first.hasAttribute('data-selected')).toBe(false);
    expect(second.hasAttribute('data-selected')).toBe(true);
    expect(timelineBox('first')).toBe(first);
    expect(first.hasAttribute('data-pending')).toBe(false);
  });

  it('As a dotli developer, hovering a timeline box shows its tooltip at once, and leaving or switching tabs hides it', () => {
    // Given
    mount();
    seedMixedTraffic();
    click(tab('timeline'));
    const box = query(
      panel(),
      '[data-testid="td-timeline"] [data-testid="td-tl-segment"][data-tooltip]',
      SVGRectElement,
    );
    const tooltip = q('[data-testid="td-tooltip"]');

    // When
    box.dispatchEvent(
      new PointerEvent('pointerover', {
        bubbles: true,
        clientX: 30,
        clientY: 40,
      }),
    );

    // Then
    expect(tooltip.hasAttribute('data-visible')).toBe(true);
    expect(tooltip.textContent).toBe(box.getAttribute('data-tooltip'));

    // When
    q('[data-testid="td-timeline"]').dispatchEvent(new PointerEvent('pointerleave'));

    // Then
    expect(tooltip.hasAttribute('data-visible')).toBe(false);

    // When
    box.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    click(tab('list'));

    // Then
    expect(tooltip.hasAttribute('data-visible')).toBe(false);
  });

  it('As a dotli developer, the Resolution view redraws an in-flight load on its tick, but not while collapsed', () => {
    // Given
    mount();
    click(tab('resolution'));
    expect(q('[data-testid="td-res"] [data-testid="td-res-empty"]')).not.toBeNull();

    // When
    system('boot', 'started', 'flow-boot', { chainBackend: 'smoldot' });
    system('resolve', 'started', 'flow-res', {
      label: 'myapp',
      source: 'smoldot',
    });
    frame();

    // Then
    expect(panel().querySelector('[data-testid="td-res"] [data-testid="td-res-summary"]')).not.toBeNull();
    expect(resolutionFact('name')).toBe('myapp');
    const first = resolutionFact('elapsed');

    // When no events arrive but time passes
    vi.advanceTimersByTime(500);

    // Then
    const second = resolutionFact('elapsed');
    expect(second).not.toBe(first);

    // When collapsed
    click(q('[data-testid="td-collapse"]'));
    vi.advanceTimersByTime(1500);

    // Then
    expect(resolutionFact('elapsed')).toBe(second);
  });

  it('As a dotli developer, the Resolution chart shows each phase, the open block and the chains that never started', () => {
    // Given
    mount();
    click(tab('resolution'));

    // When the relay connects, then syncs, and the load fails
    system('boot', 'started', 'flow-boot', { chainBackend: 'smoldot' });
    system('chain', 'phase', 'flow-chain', { chain: 'relay', phase: 'connecting' });
    vi.advanceTimersByTime(300);
    system('chain', 'phase', 'flow-chain', { chain: 'relay', phase: 'warping' });
    frame();

    // Then
    const res = q('[data-testid="td-res"]');
    const relay = query(res, '[data-testid="td-res-row"][data-role="relay"]');
    const blocks = [...relay.querySelectorAll('[data-testid="td-res-block"]')];
    expect(blocks.map(b => b.getAttribute('data-phase'))).toEqual(['connecting', 'unknown']);
    expect(blocks.map(b => b.hasAttribute('data-open'))).toEqual([false, true]);
    expect(blocks[1]?.textContent).toBe('warping');
    expect(res.querySelectorAll('[data-testid="td-res-idle"]')).toHaveLength(3);
    expect(query(res, '[data-fact="outcome"] [data-testid="td-res-value"]').getAttribute('data-tone')).toBe('running');

    // When
    system('boot', 'failed', 'flow-boot', { reason: 'no peers' });
    frame();

    // Then the load is over, so no block is open, and the reason is a tooltip
    expect(relay.querySelector('[data-testid="td-res-block"][data-open]')).toBeNull();
    const outcome = query(res, '[data-fact="outcome"] [data-testid="td-res-value"]');
    expect(outcome.textContent).toBe('failed');
    expect(outcome.getAttribute('data-tone')).toBe('bad');
    expect(outcome.getAttribute('data-tooltip')).toBe('no peers');
    expect(outcome.hasAttribute('data-tooltip-prose')).toBe(true);
  });

  it('As a dotli developer, a Resolution redraw keeps the nodes it draws, and a finished load is not touched at all', () => {
    // Given an in-flight load: a closed block and an open one
    mount();
    click(tab('resolution'));
    system('boot', 'started', 'flow-boot', { chainBackend: 'smoldot' });
    system('chain', 'phase', 'flow-chain', { chain: 'relay', phase: 'connecting' });
    vi.advanceTimersByTime(300);
    system('chain', 'phase', 'flow-chain', { chain: 'relay', phase: 'syncing' });
    frame();
    const res = q('[data-testid="td-res"]');
    const block = query(res, '[data-role="relay"] [data-testid="td-res-block"]');
    const info = query(res, '[data-fact="elapsed"] [data-testid="td-res-info"]');
    const width = block.style.width;
    expect(info.getAttribute('data-tooltip')).toBeTruthy();
    expect(info.hasAttribute('data-tooltip-prose')).toBe(true);
    expect(block.title).not.toBe('');

    // When a tick passes
    vi.advanceTimersByTime(500);

    // Then the closed block narrows as the axis grows, in the same node
    expect(query(res, '[data-role="relay"] [data-testid="td-res-block"]')).toBe(block);
    expect(block.style.width).not.toBe(width);
    expect(query(res, '[data-fact="elapsed"] [data-testid="td-res-info"]')).toBe(info);

    // When the load finishes and more ticks pass
    system('boot', 'ready', 'flow-boot');
    frame();
    const observer = new MutationObserver(() => undefined);
    observer.observe(res, { subtree: true, childList: true, attributes: true, characterData: true });
    vi.advanceTimersByTime(1500);

    // Then nothing in the view changed
    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
    expect(query(res, '[data-role="relay"] [data-testid="td-res-block"]')).toBe(block);
  });
});

describe('truapi debug panel: dock, collapse and resize', () => {
  it('As a dotli developer, the dock button switches to the right edge and back, and remembers it', () => {
    // Given: the host page, which has the topbar.
    topbarState.setTopbarPresent();
    mount();
    const dock = q('[data-testid="td-dock"]');

    // When
    click(dock);

    // Then
    expect(panel().getAttribute('data-dock')).toBe('right');
    expect(panel().getAttribute('data-layout')).toBe('stacked');
    for (const part of ['td-resize-handle', 'td-header', 'td-filters']) {
      expect(q(`[data-testid="${part}"]`).getAttribute('data-dock')).toBe('right');
    }
    expect(q('[data-testid="td-body-splitter"]').getAttribute('data-layout')).toBe('stacked');
    expect(dock.title).toBe('Dock to bottom');
    expect(dock.getAttribute('aria-label')).toBe('Dock to bottom');
    expect(localStorage.getItem('truapi-debug:dock')).toBe('right');
    expect(panel().style.top).toBe('var(--topbar-height)');

    // When
    click(dock);

    // Then
    expect(panel().getAttribute('data-dock')).toBe('bottom');
    expect(panel().hasAttribute('data-layout')).toBe(false);
    expect(q('[data-testid="td-header"]').getAttribute('data-dock')).toBe('bottom');
    expect(dock.title).toBe('Dock to right');
    expect(dock.getAttribute('aria-label')).toBe('Dock to right');
    expect(localStorage.getItem('truapi-debug:dock')).toBe('bottom');
    expect(panel().style.top).toBe('');
  });

  it('As a dotli developer, a stored right dock is applied on the next mount', () => {
    // Given
    localStorage.setItem('truapi-debug:dock', 'right');

    // When
    mount();

    // Then
    expect(panel().getAttribute('data-dock')).toBe('right');
    expect(q('[data-testid="td-dock"]').title).toBe('Dock to bottom');
    expect(panel().style.top).toBe('0px');
  });

  it('As a dotli developer, on a phone the panel docks at the bottom and stacks the list above the detail, whatever dock was stored', () => {
    // Given
    setViewportWidth(390);
    localStorage.setItem('truapi-debug:dock', 'right');
    mount();
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined);
    const splitter = q('[data-testid="td-body-splitter"]');
    vi.spyOn(must(splitter.parentElement, "the splitter's parent"), 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 390, 600),
    );

    // When
    pointer(splitter, 'pointerdown');
    pointer(splitter, 'pointermove', 0, 250);
    pointer(splitter, 'pointerup');

    // Then
    expect(panel().getAttribute('data-dock')).toBe('bottom');
    expect(panel().getAttribute('data-layout')).toBe('stacked');
    expect(panel().style.top).toBe('');
    expect(splitter.getAttribute('aria-orientation')).toBe('horizontal');
    expect(panel().style.getPropertyValue('--td-top-height')).toBe('250px');
    expect(localStorage.getItem('truapi-debug:dock')).toBe('right');
  });

  it('As a dotli developer, rotating between a narrow and a wide viewport moves the panel between the bottom and the stored dock', () => {
    // Given
    localStorage.setItem('truapi-debug:dock', 'right');
    mount();
    expect(panel().getAttribute('data-dock')).toBe('right');

    // When
    setViewportWidth(390);

    // Then
    expect(panel().getAttribute('data-dock')).toBe('bottom');
    expect(panel().getAttribute('data-layout')).toBe('stacked');
    expect(panel().style.top).toBe('');

    // When
    setViewportWidth(1024);

    // Then
    expect(panel().getAttribute('data-dock')).toBe('right');
    expect(panel().style.top).toBe('0px');
  });

  it('As a dotli developer, docking clears a dragged size and splitter position', () => {
    // Given
    mount();
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined);
    pointer(q('[data-testid="td-resize-handle"]'), 'pointerdown');
    pointer(q('[data-testid="td-resize-handle"]'), 'pointermove', 0, 500);
    pointer(q('[data-testid="td-resize-handle"]'), 'pointerup');
    panel().style.setProperty('--td-left-width', '300px');
    expect(panel().style.height).toBe('268px');

    // When
    click(q('[data-testid="td-dock"]'));

    // Then
    expect(panel().style.height).toBe('');
    expect(panel().style.width).toBe('');
    expect(panel().style.getPropertyValue('--td-left-width')).toBe('');
  });

  it('As a dotli developer, collapse toggles header-only mode and restores a dragged height on expand', () => {
    // Given
    mount();
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined);
    pointer(q('[data-testid="td-resize-handle"]'), 'pointerdown');
    pointer(q('[data-testid="td-resize-handle"]'), 'pointermove', 0, 400);
    pointer(q('[data-testid="td-resize-handle"]'), 'pointerup');
    expect(panel().style.height).toBe('368px');

    // When
    click(q('[data-testid="td-collapse"]'));

    // Then
    expect(panel().hasAttribute('data-collapsed')).toBe(true);
    expect(q('[data-testid="td-collapse"]').textContent).toBe('▲');
    expect(panel().style.height).toBe('');

    // When a drag is attempted while collapsed
    pointer(q('[data-testid="td-resize-handle"]'), 'pointerdown');
    pointer(q('[data-testid="td-resize-handle"]'), 'pointermove', 0, 100);
    pointer(q('[data-testid="td-resize-handle"]'), 'pointerup');

    // Then it is ignored
    expect(panel().style.height).toBe('');

    // When
    click(q('[data-testid="td-collapse"]'));

    // Then
    expect(panel().hasAttribute('data-collapsed')).toBe(false);
    expect(q('[data-testid="td-collapse"]').textContent).toBe('▼');
    expect(panel().style.height).toBe('368px');
  });

  it('As a dotli developer, dragging the top edge resizes the bottom-docked panel within 120px and 80% of the viewport', () => {
    // Given (happy-dom viewport: 1024 x 768)
    mount();
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined);
    const handle = q('[data-testid="td-resize-handle"]');

    // When a move happens without a drag
    pointer(handle, 'pointermove', 0, 500);

    // Then
    expect(panel().style.height).toBe('');

    // When
    pointer(handle, 'pointerdown');

    // Then
    expect(document.body.style.userSelect).toBe('none');

    // When
    pointer(handle, 'pointermove', 0, 500);

    // Then
    expect(panel().style.height).toBe('268px');

    // When
    pointer(handle, 'pointermove', 0, 740);

    // Then
    expect(panel().style.height).toBe('120px');

    // When
    pointer(handle, 'pointermove', 0, 0);

    // Then
    expect(panel().style.height).toBe('614.4px');

    // When
    pointer(handle, 'pointerup');
    pointer(handle, 'pointermove', 0, 500);

    // Then
    expect(document.body.style.userSelect).toBe('');
    expect(panel().style.height).toBe('614.4px');
  });

  it('As a dotli developer, a cancelled drag of the edge or the splitter ends it: later moves change nothing and text selection comes back', () => {
    // Given
    mount();
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined);
    const handle = q('[data-testid="td-resize-handle"]');
    const splitter = q('[data-testid="td-body-splitter"]');
    vi.spyOn(must(splitter.parentElement, "the splitter's parent"), 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 1000, 400),
    );
    pointer(handle, 'pointerdown');
    pointer(handle, 'pointermove', 0, 500);
    expect(panel().style.height).toBe('268px');

    // When
    pointer(handle, 'pointercancel');
    pointer(handle, 'pointermove', 0, 400);

    // Then
    expect(panel().style.height).toBe('268px');
    expect(document.body.style.userSelect).toBe('');

    // When
    pointer(splitter, 'pointerdown');
    pointer(splitter, 'pointermove', 400, 0);
    pointer(splitter, 'pointercancel');
    pointer(splitter, 'pointermove', 500, 0);

    // Then
    expect(panel().style.getPropertyValue('--td-left-width')).toBe('400px');
    expect(splitter.hasAttribute('data-dragging')).toBe(false);
    expect(document.body.style.userSelect).toBe('');
  });

  it('As a dotli developer, dragging the left edge resizes the right-docked panel within 280px and 80% of the viewport', () => {
    // Given
    localStorage.setItem('truapi-debug:dock', 'right');
    mount();
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined);

    // When
    pointer(q('[data-testid="td-resize-handle"]'), 'pointerdown');
    pointer(q('[data-testid="td-resize-handle"]'), 'pointermove', 600, 0);

    // Then
    expect(panel().style.width).toBe('424px');

    // When
    pointer(q('[data-testid="td-resize-handle"]'), 'pointermove', 1000, 0);

    // Then
    expect(panel().style.width).toBe('280px');

    // When
    pointer(q('[data-testid="td-resize-handle"]'), 'pointermove', 0, 0);

    // Then
    expect(panel().style.width).toBe('819.2px');
    pointer(q('[data-testid="td-resize-handle"]'), 'pointerup');
  });

  it('As a dotli developer, the body splitter rebalances the panes within the documented minimums', () => {
    // Given
    mount();
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined);
    const splitter = q('[data-testid="td-body-splitter"]');
    const body = q('[data-testid="td-body"]');
    body.getBoundingClientRect = () =>
      ({
        left: 10,
        top: 20,
        width: 1000,
        height: 600,
        right: 1010,
        bottom: 620,
        x: 10,
        y: 20,
      }) as DOMRect;

    // When
    pointer(splitter, 'pointerdown');

    // Then
    expect(splitter.hasAttribute('data-dragging')).toBe(true);
    expect(document.body.style.userSelect).toBe('none');

    // When
    pointer(splitter, 'pointermove', 510, 0);

    // Then
    expect(panel().style.getPropertyValue('--td-left-width')).toBe('500px');

    // When
    pointer(splitter, 'pointermove', 50, 0);

    // Then the list keeps 220px
    expect(panel().style.getPropertyValue('--td-left-width')).toBe('220px');

    // When
    pointer(splitter, 'pointermove', 1000, 0);

    // Then the detail keeps 260px plus the 6px splitter
    expect(panel().style.getPropertyValue('--td-left-width')).toBe('734px');

    // When
    pointer(splitter, 'pointerup');

    // Then
    expect(splitter.hasAttribute('data-dragging')).toBe(false);
    expect(document.body.style.userSelect).toBe('');

    // When
    splitter.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    // Then
    expect(panel().style.getPropertyValue('--td-left-width')).toBe('');
  });

  it('As a dotli developer, the body splitter resizes the top pane when docked right', () => {
    // Given
    localStorage.setItem('truapi-debug:dock', 'right');
    mount();
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined);
    const splitter = q('[data-testid="td-body-splitter"]');
    q('[data-testid="td-body"]').getBoundingClientRect = () =>
      ({ left: 0, top: 20, width: 400, height: 600 }) as DOMRect;

    // When
    pointer(splitter, 'pointerdown');
    pointer(splitter, 'pointermove', 0, 320);

    // Then
    expect(panel().style.getPropertyValue('--td-top-height')).toBe('300px');

    // When
    pointer(splitter, 'pointermove', 0, 30);

    // Then
    expect(panel().style.getPropertyValue('--td-top-height')).toBe('220px');

    // When
    pointer(splitter, 'pointermove', 0, 700);

    // Then
    expect(panel().style.getPropertyValue('--td-top-height')).toBe('334px');

    // When
    pointer(splitter, 'pointerup');
    splitter.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

    // Then
    expect(panel().style.getPropertyValue('--td-top-height')).toBe('');
  });
});

describe('truapi debug panel: product iframe geometry', () => {
  it('As a dotli developer, a bottom-docked panel shortens the product iframe by its height', () => {
    // Given
    stubPanelBox(400, 300);
    const frame = attachFrame(true);

    // When
    mount();

    // Then
    expect(frame['width']).toBe(SAFE_WIDTH);
    expect(frame['height']).toBe(`calc(${BELOW_BAR_HEIGHT} - 300px)`);

    // When
    click(q('[data-testid="td-collapse"]'));

    // Then
    expect(frame['height']).toBe(`calc(${BELOW_BAR_HEIGHT} - 32px)`);
  });

  it('As a dotli developer, without a topbar the frame keeps the full safe height, and a collapsed mount reserves 32px', () => {
    // Given
    stubPanelBox(400, 300);
    const frame = attachFrame(false);

    // When
    mount({ startCollapsed: true });

    // Then
    expect(frame['width']).toBe(SAFE_WIDTH);
    expect(frame['height']).toBe(`calc(${FULL_HEIGHT} - 32px)`);
  });

  it('As a dotli developer, a right-docked panel narrows the iframe by its width, and collapsing gives it back', () => {
    // Given
    stubPanelBox(400, 300);
    const frame = attachFrame(true);
    mount();

    // When
    click(q('[data-testid="td-dock"]'));

    // Then
    expect(frame['height']).toBe(BELOW_BAR_HEIGHT);
    expect(frame['width']).toBe(`calc(${SAFE_WIDTH} - 400px)`);

    // When
    click(q('[data-testid="td-collapse"]'));

    // Then
    expect(frame['width']).toBe(SAFE_WIDTH);
    expect(frame['height']).toBe(BELOW_BAR_HEIGHT);

    // When
    click(q('[data-testid="td-collapse"]'));
    click(q('[data-testid="td-dock"]'));

    // Then
    expect(frame['width']).toBe(SAFE_WIDTH);
    expect(frame['height']).toBe(`calc(${BELOW_BAR_HEIGHT} - 300px)`);
  });

  it('As a dotli developer, dragging the panel edge refits the iframe', () => {
    // Given (happy-dom viewport: 1024 x 768)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.id === PANEL_ID ? Number.parseFloat(this.style.height || '300') : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined);
    const frame = attachFrame(true);
    mount();

    // When
    pointer(q('[data-testid="td-resize-handle"]'), 'pointerdown');
    pointer(q('[data-testid="td-resize-handle"]'), 'pointermove', 0, 500);
    // The refit lands on the next animation frame.
    vi.advanceTimersByTime(20);

    // Then
    expect(frame['height']).toBe(`calc(${BELOW_BAR_HEIGHT} - 268px)`);
    pointer(q('[data-testid="td-resize-handle"]'), 'pointerup');
  });

  it('As a dotli developer, a product reload with chat open and a right dock keeps both', () => {
    // Given
    stubPanelBox(400, 300);
    localStorage.setItem('truapi-debug:dock', 'right');
    attachFrame(true);
    layout.setChatWidth(360);
    mount();

    // When the product re-renders into a new frame and announces it
    const reloaded = attachFrame(true);
    window.dispatchEvent(new CustomEvent('dotli:product-loaded'));
    layout.setChatWidth(360);

    // Then
    expect(reloaded['width']).toBe(`calc(${SAFE_WIDTH} - 760px)`);
    expect(reloaded['height']).toBe(BELOW_BAR_HEIGHT);
  });

  it('As a dotli developer, closing the panel with chat open restores the full layout', () => {
    // Given
    stubPanelBox(400, 300);
    const frame = attachFrame(true);
    layout.setChatWidth(360);
    layout.setTopbarLayout({ offset: false, shown: false, transition: '' });
    const dispose = mount();
    expect(frame['height']).toBe(`calc(${FULL_HEIGHT} - 300px)`);

    // When
    dispose();

    // Then chat, the safe insets and the tracked bar all still apply
    expect(frame['width']).toBe(`calc(${SAFE_WIDTH} - 360px)`);
    expect(frame['height']).toBe(FULL_HEIGHT);
    expect(frame['top']).toBe('var(--safe-top, 0px)');
    expect(frame['transform']).toBe('translateY(0)');

    // When a product loads after the panel is gone
    window.dispatchEvent(new CustomEvent('dotli:product-loaded'));

    // Then
    expect(frame['height']).toBe(FULL_HEIGHT);
  });
});

describe('truapi debug panel: pending requests', () => {
  it('As a dotli developer, an unanswered request shows a pending badge that counts up each second until the reply lands', () => {
    // Given
    mount();

    // When
    truapi({ tag: 'sign_request', requestId: 's1' });
    frame();

    // Then
    const badge = (): HTMLElement | null => nth(rows(), 0).querySelector<HTMLElement>('[data-testid="td-pending"]');
    expect(badge()?.hidden).toBe(false);
    expect(badge()?.textContent).toMatch(/^⟳ \d+ms pending$/);
    expect(badge()?.hasAttribute('data-slow')).toBe(false);

    // When
    vi.advanceTimersByTime(980);

    // Then
    expect(badge()?.textContent).toBe('⟳ 1.0s pending');

    // When
    vi.advanceTimersByTime(2000);

    // Then
    expect(badge()?.textContent).toBe('⟳ 3.0s pending');
    expect(badge()?.hasAttribute('data-slow')).toBe(true);

    // When
    truapi({ tag: 'sign_response', requestId: 's1', direction: 'incoming' });
    frame();

    // Then
    expect(badge()).toBeNull();
    expect(rows()[1]?.querySelector('[data-testid="td-pending"]')).toBeNull();
  });
});

describe('truapi debug panel: capacity', () => {
  it('As a dotli developer, a small capacity keeps the newest events and counts the dropped ones', () => {
    // Given
    mount({ capacity: 5 });

    // When
    for (let i = 0; i < 8; i++) {
      truapi({ tag: `ev${String(i)}_request`, requestId: `r${String(i)}` });
      frame();
    }

    // Then
    expect(rowTags()).toEqual(['ev3_request', 'ev4_request', 'ev5_request', 'ev6_request', 'ev7_request']);
    expect(counts()).toBe('5 events (+3 dropped)');
  });

  it('As a dotli developer, past the default 2000 events the oldest are pruned from the list', () => {
    // Given
    mount();

    // When
    for (let i = 0; i < 2003; i++) {
      truapi({ tag: `ev${String(i)}_x`, requestId: `r${String(i)}` });
    }
    frame();

    // Then
    const tags = rowTags();
    expect(tags).toHaveLength(2000);
    expect(tags[0]).toBe('ev3_x');
    expect(tags[1999]).toBe('ev2002_x');
    expect(counts()).toBe('2000 events (+3 dropped)');
  });
});

describe('truapi debug panel: streaming load', () => {
  it('As a dotli developer, a clicked row keeps its node and selection while events stream in', () => {
    // Given
    mount();
    seedMixedTraffic();
    const before = rows();
    const target = rowByTag('system_handshake_request');
    click(target);
    const detailPre = q('[data-testid="td-detail-pre"]');

    // When a burst streams in over several frames
    for (let f = 0; f < 10; f++) {
      for (let i = 0; i < 10; i++) {
        truapi({
          tag: `burst_receive`,
          requestId: `burst-${String(f)}-${String(i)}`,
          direction: 'incoming',
        });
      }
      frame();
    }

    // Then
    expect(rows()).toHaveLength(103);
    before.forEach((node, i) => {
      expect(rows()[i]).toBe(node);
    });
    expect(target.isConnected).toBe(true);
    expect(target.getAttribute('data-selection')).toBe('selected');
    expect(q('[data-testid="td-detail-pre"]')).toBe(detailPre);
  });

  it('As a dotli developer, a click that lands mid-burst sticks after the next render', () => {
    // Given
    mount();
    seedMixedTraffic();
    const target = rowByTag('system_handshake_response');

    // When events are queued, the click lands before the frame renders them
    for (let i = 0; i < 20; i++) {
      truapi({ tag: 'burst_receive', requestId: `b-${String(i)}` });
    }
    click(target);
    frame();

    // Then
    expect(rowByTag('system_handshake_response')).toBe(target);
    expect(target.getAttribute('data-selection')).toBe('selected');
    expect(detailRows()['tag']).toBe('system_handshake_response');
    expect(rows()).toHaveLength(23);
  });
});
