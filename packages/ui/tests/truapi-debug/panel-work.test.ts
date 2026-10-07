// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Counts the panel's work per frame, click and tick at its 2000-event capacity, through wrapped pure
// helpers and Solid's dev warnings on `console.warn`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type * as FiltersModule from '../../../truapi-debug/src/filters.js';
import type * as PendingModule from '../../../truapi-debug/src/pending.js';
import type * as RowFormatModule from '../../../truapi-debug/src/row-format.js';
import type * as TimelineModule from '../../../truapi-debug/src/timeline.js';
import type * as ResolutionViewModule from '../../../truapi-debug/src/resolution-view.js';
import type * as KeyedSignalsModule from '../../src/components/truapi-debug/keyed-signals.js';
import type * as DotliDebugBusModule from '../../../truapi-debug/src/dotli-debug-bus.js';
import type * as MountModule from '../../src/components/truapi-debug/mount.js';
import type * as ProductFrameLayoutModule from '../../src/product-frame-layout.js';
import { byTestId, query } from '../support.js';
import { nth } from '../helpers/nth.js';

// Rendering 2000 rows takes seconds on a loaded CI runner. The tests count work, not time.
vi.setConfig({ testTimeout: 20_000 });

const calls = vi.hoisted(() => ({
  matches: 0,
  formatPending: 0,
  rowSelection: 0,
  buildTimeline: 0,
  buildResolution: 0,
}));

function resetCalls(): void {
  for (const key of Object.keys(calls) as (keyof typeof calls)[]) {
    calls[key] = 0;
  }
}

vi.mock('../../../truapi-debug/src/filters.js', async importOriginal => {
  const real = await importOriginal<typeof FiltersModule>();
  return {
    ...real,
    matches: (...args: Parameters<typeof real.matches>) => {
      calls.matches++;
      return real.matches(...args);
    },
  };
});
vi.mock('../../../truapi-debug/src/pending.js', async importOriginal => {
  const real = await importOriginal<typeof PendingModule>();
  return {
    ...real,
    formatPending: (...args: Parameters<typeof real.formatPending>) => {
      calls.formatPending++;
      return real.formatPending(...args);
    },
  };
});
vi.mock('../../../truapi-debug/src/row-format.js', async importOriginal => {
  const real = await importOriginal<typeof RowFormatModule>();
  return {
    ...real,
    rowSelection: (...args: Parameters<typeof real.rowSelection>) => {
      calls.rowSelection++;
      return real.rowSelection(...args);
    },
  };
});
vi.mock('../../../truapi-debug/src/timeline.js', async importOriginal => {
  const real = await importOriginal<typeof TimelineModule>();
  return {
    ...real,
    buildTimeline: (...args: Parameters<typeof real.buildTimeline>) => {
      calls.buildTimeline++;
      return real.buildTimeline(...args);
    },
  };
});
vi.mock('../../../truapi-debug/src/resolution-view.js', async importOriginal => {
  const real = await importOriginal<typeof ResolutionViewModule>();
  return {
    ...real,
    buildResolution: (...args: Parameters<typeof real.buildResolution>) => {
      calls.buildResolution++;
      return real.buildResolution(...args);
    },
  };
});

const keyedMaps = vi.hoisted(() => [] as { subscribedKeys: () => IterableIterator<unknown> }[]);
vi.mock('../../src/components/truapi-debug/keyed-signals.js', async importOriginal => {
  const real = await importOriginal<typeof KeyedSignalsModule>();
  return {
    ...real,
    createKeyedSignals: () => {
      const map = real.createKeyedSignals();
      keyedMaps.push(map);
      return map;
    },
  };
});

type Bus = typeof DotliDebugBusModule;
type BusEvent = Parameters<Bus['emitDotliDebugEvent']>[0];
type PanelModule = typeof MountModule;

const PANEL_ID = 'truapi-debug-panel';

let bus: Bus;
let layout: typeof ProductFrameLayoutModule;
let panelModule: PanelModule;
let disposers: (() => void)[] = [];
let warn: MockInstance<typeof console.warn>;

beforeEach(async () => {
  vi.useFakeTimers({ now: new Date(2026, 8, 25, 12, 0, 0) });
  vi.resetModules();
  document.head.replaceChildren();
  document.body.replaceChildren();
  localStorage.clear();
  bus = await import('../../../truapi-debug/src/dotli-debug-bus.js');
  layout = await import('../../src/product-frame-layout.js');
  panelModule = await import('../../src/components/truapi-debug/mount.js');
  bus.enableDotliDebugBuffering();
  warn = vi.spyOn(console, 'warn');
  resetCalls();
  keyedMaps.length = 0;
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

function mount(options?: { capacity?: number; startCollapsed?: boolean }): void {
  disposers.push(panelModule.setupTruapiDebugPanel(options));
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

function frame(): void {
  vi.advanceTimersByTime(20);
}

function truapi(tag: string, requestId: string, direction: 'incoming' | 'outgoing' = 'outgoing'): void {
  bus.emitDotliDebugEvent({
    kind: 'truapi',
    direction,
    productId: 'app.dot',
    requestId,
    payload: { tag, value: {} },
  });
}

function system(layer: string, event: string, flowId: string): void {
  bus.emitDotliDebugEvent({
    layer,
    event,
    flowId,
    timestamp: Date.now(),
    payload: {},
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

function attachCountingFrame(): {
  style: Record<string, string>;
  writes: () => number;
} {
  let writes = 0;
  const style = new Proxy<Record<string, string>>(
    {},
    {
      set(target, prop, value: string) {
        if (prop === 'height') {
          writes++;
        }
        target[prop as string] = value;
        return true;
      },
    },
  );
  layout.attachProductFrame({ style } as unknown as HTMLIFrameElement);
  return { style, writes: () => writes };
}

function fanOutWarnings(): string[] {
  return warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('HUGE_FAN_OUT'));
}

function fillWithPendingRequests(): void {
  for (let i = 0; i < 2000; i++) {
    truapi('host_sign_request', `r${String(i)}`);
  }
  frame();
}

function fillWithAnsweredPairs(pairs = 1000): void {
  for (let i = 0; i < pairs; i++) {
    truapi('host_sign_request', `q${String(i)}`);
    truapi('host_sign_response', `q${String(i)}`);
  }
  frame();
}

describe('truapi debug panel work: collapsed and hidden views', () => {
  it('As a dotli developer, a collapsed panel only keeps its header count per frame, and catches up once on expand', () => {
    // Given
    mount({ startCollapsed: true });
    fillWithPendingRequests();
    resetCalls();

    // When traffic arrives over ten frames while collapsed
    for (let i = 0; i < 10; i++) {
      truapi('host_sign_request', `new${String(i)}`);
      frame();
    }

    // Then only the new events are matched, for the header count
    expect(calls.matches).toBe(10);
    expect(calls.formatPending).toBe(0);
    expect(rows()).toHaveLength(0);
    expect(q('[data-testid="td-counts"]').textContent).toBe('2000 events (+10 dropped)');

    // When
    click(q('[data-testid="td-collapse"]'));

    // Then it catches up once
    expect(q('[data-testid="td-counts"]').textContent).toBe('2000 events (+10 dropped)');
    expect(rows()).toHaveLength(2000);
    expect(nth(rows(), 1999).querySelector('[data-testid="td-pending"]')).not.toBeNull();
    expect(calls.matches).toBeLessThanOrEqual(2010);
  });

  it('As a dotli developer, the pending badge clock stops while the panel is collapsed', () => {
    // Given
    mount();
    truapi('host_sign_request', 'r1');
    frame();
    const expanded = vi.getTimerCount();

    // When
    click(q('[data-testid="td-collapse"]'));

    // Then
    expect(vi.getTimerCount()).toBe(expanded - 1);

    // When
    click(q('[data-testid="td-collapse"]'));

    // Then
    expect(vi.getTimerCount()).toBe(expanded);
  });

  it('As a dotli developer, the pending badge clock renders nothing while no call is pending', () => {
    // Given
    mount();
    fillWithAnsweredPairs();
    resetCalls();

    // When three ticks pass
    vi.advanceTimersByTime(3000);

    // Then
    expect(calls.formatPending).toBe(0);
  });

  it('As a dotli developer, with the Resolution tab open TrUAPI traffic neither recomputes pending calls nor redraws the resolution', () => {
    // Given
    mount();
    fillWithPendingRequests();
    click(q('[data-testid="td-tab"][data-view="resolution"]'));
    // Just past a resolution tick, so the next ten frames stay clear of one.
    vi.advanceTimersByTime(500 - (Date.now() % 500) + 1);
    resetCalls();

    // When
    for (let i = 0; i < 10; i++) {
      truapi('host_sign_request', `new${String(i)}`);
      frame();
    }

    // Then
    expect(calls.formatPending).toBe(0);
    expect(calls.buildResolution).toBe(0);
    expect(q('[data-testid="td-counts"]').textContent).toBe('2000 events (+10 dropped)');

    // When
    click(q('[data-testid="td-tab"][data-view="list"]'));

    // Then the badges catch up once
    expect(byTestId('td-pending', nth(rows(), 1999)).textContent).toMatch(/^⟳ \d+ms pending$/);
    expect(panel().querySelectorAll('[data-testid="td-pending"]')).toHaveLength(2000);
  });

  it('As a dotli developer, the Resolution view still redraws when a system event lands', () => {
    // Given
    mount();
    click(q('[data-testid="td-tab"][data-view="resolution"]'));
    vi.advanceTimersByTime(500 - (Date.now() % 500) + 1);
    resetCalls();

    // When
    system('boot', 'started', 'flow-boot');
    frame();

    // Then
    expect(calls.buildResolution).toBe(1);
    expect(panel().querySelector('[data-testid="td-res"] [data-testid="td-res-summary"]')).not.toBeNull();
  });

  it('As a dotli developer, the timeline does not re-lay out for a frame whose events are all filtered out', () => {
    // Given
    // Below capacity: at capacity every new event evicts a visible one.
    mount();
    fillWithAnsweredPairs(500);
    type(byTestId('td-exclude-input', panel(), HTMLInputElement), 'noise');
    click(q('[data-testid="td-tab"][data-view="timeline"]'));
    resetCalls();

    // When
    for (let i = 0; i < 5; i++) {
      truapi('noise_receive', `n${String(i)}`);
      frame();
    }

    // Then
    expect(calls.buildTimeline).toBe(0);
  });
});

describe('truapi debug panel work: traffic at capacity', () => {
  it('As a dotli developer, one new event at 2000 pending filters and renders only that event', () => {
    // Given
    mount();
    fillWithPendingRequests();
    resetCalls();
    warn.mockClear();

    // When
    truapi('host_sign_request', 'new');
    frame();

    // Then
    expect(calls.matches).toBe(1);
    expect(calls.formatPending).toBeLessThanOrEqual(2);
    expect(nth(rows(), 1999).querySelector('[data-testid="td-pending"]')).not.toBeNull();
    expect(fanOutWarnings()).toEqual([]);
  });

  it('As a dotli developer, a pending tick at 2000 pending updates every badge without a fan-out warning', () => {
    // Given
    mount();
    fillWithPendingRequests();
    const badge = byTestId('td-pending', nth(rows(), 0));
    warn.mockClear();

    // When
    vi.advanceTimersByTime(1000);

    // Then
    expect(badge.textContent).toBe('⟳ 1.0s pending');
    expect(byTestId('td-pending', nth(rows(), 1999)).textContent).toBe('⟳ 1.0s pending');
    expect(fanOutWarnings()).toEqual([]);
  });

  it('As a dotli developer, one new answered pair at 1000 pairs filters only the new events', () => {
    // Given
    mount();
    fillWithAnsweredPairs();
    resetCalls();

    // When
    truapi('host_sign_request', 'z1');
    truapi('host_sign_response', 'z1');
    frame();

    // Then
    expect(calls.matches).toBe(2);
    expect(calls.formatPending).toBe(0);
  });
});

describe('truapi debug panel work: selection', () => {
  it('As a dotli developer, a click at 2000 rows restyles only the rows whose selection changed', () => {
    // Given
    mount();
    fillWithAnsweredPairs();
    warn.mockClear();
    resetCalls();

    // When
    click(nth(rows(), 500));

    // Then
    expect(rows()[500]?.getAttribute('data-selection')).toBe('selected');
    expect(rows()[501]?.getAttribute('data-selection')).toBe('paired');
    expect(calls.rowSelection).toBeLessThanOrEqual(4);
    expect(fanOutWarnings()).toEqual([]);

    // When
    resetCalls();
    click(nth(rows(), 900));

    // Then
    expect(rows()[500]?.hasAttribute('data-selection')).toBe(false);
    expect(rows()[501]?.hasAttribute('data-selection')).toBe(false);
    expect(rows()[900]?.getAttribute('data-selection')).toBe('selected');
    expect(calls.rowSelection).toBeLessThanOrEqual(4);
  });

  it('As a dotli developer, arrow keys at 2000 rows restyle only the rows whose selection changed', () => {
    // Given
    mount();
    fillWithPendingRequests();
    click(nth(rows(), 10));
    warn.mockClear();
    resetCalls();

    // When
    for (let i = 0; i < 20; i++) {
      key(q('[data-testid="td-list"]'), 'ArrowDown');
    }

    // Then
    expect(rows()[30]?.getAttribute('data-selection')).toBe('selected');
    expect(rows()[10]?.hasAttribute('data-selection')).toBe(false);
    expect(calls.rowSelection).toBeLessThanOrEqual(40);
    expect(fanOutWarnings()).toEqual([]);
  });
});

describe('truapi debug panel work: filters and detail', () => {
  it('As a dotli developer, typing a filter that keeps the selected event visible leaves the detail pane alone', () => {
    // Given
    mount();
    system('boot', 'started', 'flow-boot-1');
    truapi('host_sign_request', 'a1');
    frame();
    click(nth(rows(), 0));
    const explanation = query(panel(), '[data-testid="td-detail"] details', HTMLDetailsElement);
    explanation.open = true;

    // When
    const input = byTestId('td-tag-input', panel(), HTMLInputElement);
    type(input, 'b');
    type(input, 'bo');
    type(input, 'boo');

    // Then
    expect(rows()).toHaveLength(1);
    expect(q('[data-testid="td-detail"] details')).toBe(explanation);
    expect(explanation.open).toBe(true);
  });
});

describe('truapi debug panel work: rows', () => {
  it("As a dotli developer, a row's latency does not depend on when the row was created", () => {
    // Given
    mount({ capacity: 3 });
    truapi('host_sign_request', 'r1');
    vi.advanceTimersByTime(50);
    truapi('host_sign_response', 'r1', 'incoming');
    frame();
    const latency = (): string | null | undefined =>
      rows()
        .find(r => byTestId('td-tag', r).textContent === 'host_sign_response')
        ?.querySelector('[data-testid="td-latency"]')?.textContent;
    expect(latency()).toBe('+50ms');

    // When the reply row is filtered out, the request is evicted, and the
    // reply row is created again
    const exclude = byTestId('td-exclude-input', panel(), HTMLInputElement);
    type(exclude, 'response');
    truapi('noise_receive', 'n1');
    truapi('noise_receive', 'n2');
    frame();
    type(exclude, '');

    // Then
    expect(latency()).toBe('+50ms');
  });

  it('As a dotli developer, reading scrolled up at capacity keeps the rows under the reader as the head is evicted', () => {
    // Given 20px rows in a 100px list
    mount({ capacity: 50 });
    for (let i = 0; i < 50; i++) {
      truapi('x_receive', `r${String(i)}`);
    }
    frame();
    const list = q('[data-testid="td-list"]');
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      const parent = this.parentElement;
      return this.hasAttribute('data-seq') && parent !== null ? [...parent.children].indexOf(this) * 20 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this === list ? this.children.length * 20 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this === list ? 100 : 0;
    });
    list.scrollTop = 200;
    const topRow = rows()[10];

    // When five new events evict the five oldest
    for (let i = 0; i < 5; i++) {
      truapi('x_receive', `n${String(i)}`);
    }
    frame();

    // Then
    expect(rows()[5]).toBe(topRow);
    expect(list.scrollTop).toBe(100);
  });
});

describe('truapi debug panel work: pointer moves', () => {
  it('As a dotli developer, dragging the panel edge reads no layout and refits the app frame once per animation frame', () => {
    // Given
    let heightReads = 0;
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.id !== PANEL_ID) {
        return 0;
      }
      heightReads++;
      return Number.parseFloat(this.style.height || '300');
    });
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined);
    const appFrame = attachCountingFrame();
    mount();
    pointer(q('[data-testid="td-resize-handle"]'), 'pointerdown');
    heightReads = 0;
    const writesBefore = appFrame.writes();

    // When five moves land in one frame
    for (let i = 0; i < 5; i++) {
      pointer(q('[data-testid="td-resize-handle"]'), 'pointermove', 0, 500 + i);
    }

    // Then
    expect(panel().style.height).toBe('264px');
    expect(heightReads).toBe(0);
    expect(appFrame.writes() - writesBefore).toBe(0);

    // When
    frame();

    // Then
    expect(appFrame.writes() - writesBefore).toBe(1);
    expect(appFrame.style['height']).toMatch(/ - 264px\)$/);
    pointer(q('[data-testid="td-resize-handle"]'), 'pointerup');
  });

  it('As a dotli developer, dragging the body splitter measures the body once per drag', () => {
    // Given
    vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => undefined);
    mount();
    let measures = 0;
    q('[data-testid="td-body"]').getBoundingClientRect = () => {
      measures++;
      return { left: 10, top: 20, width: 1000, height: 600 } as DOMRect;
    };

    // When
    pointer(q('[data-testid="td-body-splitter"]'), 'pointerdown');
    pointer(q('[data-testid="td-body-splitter"]'), 'pointermove', 510, 0);
    pointer(q('[data-testid="td-body-splitter"]'), 'pointermove', 520, 0);
    pointer(q('[data-testid="td-body-splitter"]'), 'pointermove', 530, 0);
    pointer(q('[data-testid="td-body-splitter"]'), 'pointerup');

    // Then
    expect(panel().style.getPropertyValue('--td-left-width')).toBe('520px');
    expect(measures).toBe(1);
  });

  it('As a dotli developer, moving over one timeline box repositions its tooltip without measuring or rewriting it', () => {
    // Given
    mount();
    truapi('host_sign_request', 'r1');
    vi.advanceTimersByTime(50);
    truapi('host_sign_response', 'r1', 'incoming');
    frame();
    click(q('[data-testid="td-tab"][data-view="timeline"]'));
    const box = query(
      panel(),
      '[data-testid="td-timeline"] [data-testid="td-tl-segment"][data-tooltip]',
      SVGRectElement,
    );
    const tooltip = q('[data-testid="td-tooltip"]');
    // happy-dom lays nothing out: give the panel and the tooltip a box.
    let measures = 0;
    panel().getBoundingClientRect = () => {
      measures++;
      return { left: 0, top: 0, right: 1000, bottom: 600 } as DOMRect;
    };
    tooltip.getBoundingClientRect = () => {
      measures++;
      return { width: 100, height: 20 } as DOMRect;
    };
    pointer(box, 'pointerover', 30, 40);
    expect(tooltip.hasAttribute('data-visible')).toBe(true);
    expect(tooltip.style.left).toBe('42px');
    measures = 0;
    let textWrites = 0;
    let proto: object | null = Object.getPrototypeOf(tooltip) as object;
    while (proto !== null && !Object.hasOwn(proto, 'textContent')) {
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    const textContent = proto === null ? undefined : Object.getOwnPropertyDescriptor(proto, 'textContent');
    Object.defineProperty(tooltip, 'textContent', {
      configurable: true,
      get() {
        return textContent?.get?.call(this) as string;
      },
      set(value: string) {
        textWrites++;
        textContent?.set?.call(this, value);
      },
    });

    // When
    for (let i = 1; i <= 5; i++) {
      pointer(box, 'pointermove', 30 + i, 40);
    }

    // Then
    expect(measures).toBe(0);
    expect(textWrites).toBe(0);
    expect(tooltip.style.left).toBe('47px');
    expect(tooltip.textContent).toBe(box.getAttribute('data-tooltip'));
  });
});

describe('truapi debug panel work: keyed row state', () => {
  it('As a dotli developer, evicted rows release their per-row selection and badge entries', () => {
    // Given
    mount({ capacity: 10 });
    for (let i = 0; i < 10; i++) {
      truapi('host_sign_request', `old${String(i)}`);
    }
    frame();
    click(nth(rows(), 0));
    const subscribed = (): string[] => keyedMaps.flatMap(map => [...map.subscribedKeys()].map(String));
    expect(subscribed().some(k => k.includes('old'))).toBe(true);

    // When ten new requests evict every row
    for (let i = 0; i < 10; i++) {
      truapi('host_sign_request', `new${String(i)}`);
    }
    frame();

    // Then only the current rows hold entries: a seq, a group key and a
    // pending key each
    const seqs = rows().map(r => r.dataset['seq'] ?? '');
    const keys = subscribed();
    expect(keys.filter(k => k.includes('old'))).toEqual([]);
    expect(keys).toHaveLength(30);
    expect(seqs.every(seq => keys.includes(seq))).toBe(true);
  });
});
