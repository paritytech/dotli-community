// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How much work the TrUAPI debug panel does per animation frame, click and
// tick at its 2000-event capacity. The pure helpers the panel calls are
// wrapped (`vi.mock`) so a test can count how often each runs, and Solid's
// dev diagnostics are read off `console.warn`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  matches: 0,
  openCalls: 0,
  formatPending: 0,
  rowClassName: 0,
  renderSwimlanes: 0,
  buildResolution: 0,
}));

function resetCalls(): void {
  for (const key of Object.keys(calls) as (keyof typeof calls)[]) {
    calls[key] = 0;
  }
}

vi.mock("@dotli/truapi-debug/filters", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@dotli/truapi-debug/filters")>();
  return {
    ...real,
    matches: (...args: Parameters<typeof real.matches>) => {
      calls.matches++;
      return real.matches(...args);
    },
  };
});
vi.mock("@dotli/truapi-debug/pending", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@dotli/truapi-debug/pending")>();
  return {
    ...real,
    openCalls: (...args: Parameters<typeof real.openCalls>) => {
      calls.openCalls++;
      return real.openCalls(...args);
    },
    formatPending: (...args: Parameters<typeof real.formatPending>) => {
      calls.formatPending++;
      return real.formatPending(...args);
    },
  };
});
vi.mock("@dotli/truapi-debug/row-format", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@dotli/truapi-debug/row-format")>();
  return {
    ...real,
    rowClassName: (...args: Parameters<typeof real.rowClassName>) => {
      calls.rowClassName++;
      return real.rowClassName(...args);
    },
  };
});
vi.mock("@dotli/truapi-debug/timeline", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@dotli/truapi-debug/timeline")>();
  return {
    ...real,
    renderSwimlanes: (...args: Parameters<typeof real.renderSwimlanes>) => {
      calls.renderSwimlanes++;
      real.renderSwimlanes(...args);
    },
  };
});
vi.mock("@dotli/truapi-debug/resolution-view", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("@dotli/truapi-debug/resolution-view")
    >();
  return {
    ...real,
    buildResolution: (...args: Parameters<typeof real.buildResolution>) => {
      calls.buildResolution++;
      return real.buildResolution(...args);
    },
  };
});

/** Every keyed-signal map the list creates, in creation order. */
const keyedMaps = vi.hoisted(
  () => [] as { subscribedKeys: () => IterableIterator<unknown> }[],
);
vi.mock(
  "@dotli/ui/components/truapi-debug/keyed-signals",
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import("@dotli/ui/components/truapi-debug/keyed-signals")
      >();
    return {
      ...real,
      createKeyedSignals: () => {
        const map = real.createKeyedSignals();
        keyedMaps.push(map);
        return map;
      },
    };
  },
);

type Bus = typeof import("@dotli/truapi-debug/dotli-debug-bus");
type BusEvent = Parameters<Bus["emitDotliDebugEvent"]>[0];
type PanelModule = typeof import("@dotli/ui/components/truapi-debug/mount");

const PANEL_ID = "truapi-debug-panel";

let bus: Bus;
let layout: typeof import("@dotli/ui/product-frame-layout");
let panelModule: PanelModule;
let disposers: (() => void)[] = [];
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  const { settings } = (
    window as unknown as {
      happyDOM: {
        settings: {
          disableCSSFileLoading: boolean;
          handleDisabledFileLoadingAsSuccess: boolean;
        };
      };
    }
  ).happyDOM;
  settings.disableCSSFileLoading = true;
  settings.handleDisabledFileLoadingAsSuccess = true;
  vi.useFakeTimers({ now: new Date(2026, 8, 25, 12, 0, 0) });
  vi.resetModules();
  document.head.replaceChildren();
  document.body.replaceChildren();
  localStorage.clear();
  bus = await import("@dotli/truapi-debug/dotli-debug-bus");
  layout = await import("@dotli/ui/product-frame-layout");
  panelModule = await import("@dotli/ui/components/truapi-debug/mount");
  bus.enableDotliDebugBuffering();
  warn = vi.spyOn(console, "warn");
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

// Helpers

function mount(options?: { capacity?: number; startCollapsed?: boolean }) {
  disposers.push(panelModule.setupTruapiDebugPanel(options));
}

function panel(): HTMLElement {
  const el = document.getElementById(PANEL_ID);
  if (el === null) {
    throw new Error("panel is not mounted");
  }
  return el;
}

function q<T extends Element = HTMLElement>(selector: string): T {
  const el = panel().querySelector<T>(selector);
  if (el === null) {
    throw new Error(`missing ${selector}`);
  }
  return el;
}

function rows(): HTMLElement[] {
  return [...panel().querySelectorAll<HTMLElement>(".td-list .td-row")];
}

function frame(): void {
  vi.advanceTimersByTime(20);
}

function truapi(
  tag: string,
  requestId: string,
  direction: "incoming" | "outgoing" = "outgoing",
): void {
  bus.emitDotliDebugEvent({
    kind: "truapi",
    direction,
    productId: "app.dot",
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
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function key(el: Element, name: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
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

/** A stand-in product frame counting how often its height is written. */
function attachCountingFrame(): {
  style: Record<string, string>;
  writes: () => number;
} {
  let writes = 0;
  const style = new Proxy<Record<string, string>>(
    {},
    {
      set(target, prop, value: string) {
        if (prop === "height") {
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

/** Solid's HUGE_FAN_OUT dev warnings logged since the last clear. */
function fanOutWarnings(): string[] {
  return warn.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((m: string) => m.includes("HUGE_FAN_OUT"));
}

/** Fill the store to capacity with unanswered requests, and render them. */
function fillWithPendingRequests(): void {
  for (let i = 0; i < 2000; i++) {
    truapi("host_sign_request", `r${String(i)}`);
  }
  frame();
}

/** Fill the store (to capacity by default) with answered request/response
 *  pairs. */
function fillWithAnsweredPairs(pairs = 1000): void {
  for (let i = 0; i < pairs; i++) {
    truapi("host_sign_request", `q${String(i)}`);
    truapi("host_sign_response", `q${String(i)}`);
  }
  frame();
}

// Tests

describe("truapi debug panel work: collapsed and hidden views", () => {
  it("As a dotli developer, a collapsed panel only keeps its header count per frame, and catches up once on expand", () => {
    // Given
    mount({ startCollapsed: true });
    fillWithPendingRequests();
    resetCalls();

    // When traffic arrives over ten frames while collapsed
    for (let i = 0; i < 10; i++) {
      truapi("host_sign_request", `new${String(i)}`);
      frame();
    }

    // Then only the new events are matched, for the header count
    expect(calls.matches).toBe(10);
    expect(calls.openCalls).toBe(0);
    expect(calls.formatPending).toBe(0);
    expect(rows()).toHaveLength(0);
    expect(q(".td-counts").textContent).toBe("2000 events (+10 dropped)");

    // When
    click(q(".td-collapse"));

    // Then it catches up once
    expect(q(".td-counts").textContent).toBe("2000 events (+10 dropped)");
    expect(rows()).toHaveLength(2000);
    expect(rows()[1999].querySelector(".td-pending")).not.toBeNull();
    expect(calls.matches).toBeLessThanOrEqual(2010);
  });

  it("As a dotli developer, the pending badge clock stops while the panel is collapsed", () => {
    // Given
    mount();
    truapi("host_sign_request", "r1");
    frame();
    const expanded = vi.getTimerCount();

    // When
    click(q(".td-collapse"));

    // Then
    expect(vi.getTimerCount()).toBe(expanded - 1);

    // When
    click(q(".td-collapse"));

    // Then
    expect(vi.getTimerCount()).toBe(expanded);
  });

  it("As a dotli developer, the pending badge clock renders nothing while no call is pending", () => {
    // Given
    mount();
    fillWithAnsweredPairs();
    resetCalls();

    // When three ticks pass
    vi.advanceTimersByTime(3000);

    // Then
    expect(calls.formatPending).toBe(0);
  });

  it("As a dotli developer, with the Resolution tab open TrUAPI traffic neither recomputes pending calls nor redraws the resolution", () => {
    // Given
    mount();
    fillWithPendingRequests();
    click(q('.td-tab[data-view="resolution"]'));
    // Just past a resolution tick, so the next ten frames stay clear of one.
    vi.advanceTimersByTime(500 - (Date.now() % 500) + 1);
    resetCalls();

    // When
    for (let i = 0; i < 10; i++) {
      truapi("host_sign_request", `new${String(i)}`);
      frame();
    }

    // Then
    expect(calls.openCalls).toBe(0);
    expect(calls.formatPending).toBe(0);
    expect(calls.buildResolution).toBe(0);
    expect(q(".td-counts").textContent).toBe("2000 events (+10 dropped)");

    // When
    click(q('.td-tab[data-view="list"]'));

    // Then the badges catch up once
    expect(rows()[1999].querySelector(".td-pending")?.textContent).toMatch(
      /^⟳ \d+ms pending$/,
    );
    expect(panel().querySelectorAll(".td-pending")).toHaveLength(2000);
  });

  it("As a dotli developer, the Resolution view still redraws when a system event lands", () => {
    // Given
    mount();
    click(q('.td-tab[data-view="resolution"]'));
    vi.advanceTimersByTime(500 - (Date.now() % 500) + 1);
    resetCalls();

    // When
    system("boot", "started", "flow-boot");
    frame();

    // Then
    expect(calls.buildResolution).toBe(1);
    expect(panel().querySelector(".td-res .td-res-summary")).not.toBeNull();
  });

  it("As a dotli developer, the timeline does not re-lay out for a frame whose events are all filtered out", () => {
    // Given
    // Below capacity: at capacity every new event evicts a visible one.
    mount();
    fillWithAnsweredPairs(500);
    type(q<HTMLInputElement>(".td-exclude-input"), "noise");
    click(q('.td-tab[data-view="timeline"]'));
    resetCalls();

    // When
    for (let i = 0; i < 5; i++) {
      truapi("noise_receive", `n${String(i)}`);
      frame();
    }

    // Then
    expect(calls.renderSwimlanes).toBe(0);
  });
});

describe("truapi debug panel work: traffic at capacity", () => {
  it("As a dotli developer, one new event at 2000 pending filters and renders only that event", () => {
    // Given
    mount();
    fillWithPendingRequests();
    resetCalls();
    warn.mockClear();

    // When
    truapi("host_sign_request", "new");
    frame();

    // Then
    expect(calls.matches).toBe(1);
    expect(calls.formatPending).toBeLessThanOrEqual(2);
    expect(rows()[1999].querySelector(".td-pending")).not.toBeNull();
    expect(fanOutWarnings()).toEqual([]);
  });

  it("As a dotli developer, a pending tick at 2000 pending updates every badge without a fan-out warning", () => {
    // Given
    mount();
    fillWithPendingRequests();
    const badge = rows()[0].querySelector(".td-pending");
    warn.mockClear();

    // When
    vi.advanceTimersByTime(1000);

    // Then
    expect(badge?.textContent).toBe("⟳ 1.0s pending");
    expect(rows()[1999].querySelector(".td-pending")?.textContent).toBe(
      "⟳ 1.0s pending",
    );
    expect(fanOutWarnings()).toEqual([]);
  });

  it("As a dotli developer, one new answered pair at 1000 pairs filters only the new events", () => {
    // Given
    mount();
    fillWithAnsweredPairs();
    resetCalls();

    // When
    truapi("host_sign_request", "z1");
    truapi("host_sign_response", "z1");
    frame();

    // Then
    expect(calls.matches).toBe(2);
    expect(calls.formatPending).toBe(0);
  });
});

describe("truapi debug panel work: selection", () => {
  it("As a dotli developer, a click at 2000 rows restyles only the rows whose selection changed", () => {
    // Given
    mount();
    fillWithAnsweredPairs();
    warn.mockClear();
    resetCalls();

    // When
    click(rows()[500]);

    // Then
    expect(rows()[500].className).toBe("td-row selected");
    expect(rows()[501].className).toBe("td-row paired");
    expect(calls.rowClassName).toBeLessThanOrEqual(4);
    expect(fanOutWarnings()).toEqual([]);

    // When
    resetCalls();
    click(rows()[900]);

    // Then
    expect(rows()[500].className).toBe("td-row");
    expect(rows()[501].className).toBe("td-row");
    expect(rows()[900].className).toBe("td-row selected");
    expect(calls.rowClassName).toBeLessThanOrEqual(4);
  });

  it("As a dotli developer, arrow keys at 2000 rows restyle only the rows whose selection changed", () => {
    // Given
    mount();
    fillWithPendingRequests();
    click(rows()[10]);
    warn.mockClear();
    resetCalls();

    // When
    for (let i = 0; i < 20; i++) {
      key(q(".td-list"), "ArrowDown");
    }

    // Then
    expect(rows()[30].className).toBe("td-row selected");
    expect(rows()[10].className).toBe("td-row");
    expect(calls.rowClassName).toBeLessThanOrEqual(40);
    expect(fanOutWarnings()).toEqual([]);
  });
});

describe("truapi debug panel work: filters and detail", () => {
  it("As a dotli developer, typing a filter that keeps the selected event visible leaves the detail pane alone", () => {
    // Given
    mount();
    system("boot", "started", "flow-boot-1");
    truapi("host_sign_request", "a1");
    frame();
    click(rows()[0]);
    const explanation = q<HTMLDetailsElement>(".td-detail details");
    explanation.open = true;

    // When
    const input = q<HTMLInputElement>(".td-tag-input");
    type(input, "b");
    type(input, "bo");
    type(input, "boo");

    // Then
    expect(rows()).toHaveLength(1);
    expect(q(".td-detail details")).toBe(explanation);
    expect(explanation.open).toBe(true);
  });
});

describe("truapi debug panel work: rows", () => {
  it("As a dotli developer, a row's latency does not depend on when the row was created", () => {
    // Given
    mount({ capacity: 3 });
    truapi("host_sign_request", "r1");
    vi.advanceTimersByTime(50);
    truapi("host_sign_response", "r1", "incoming");
    frame();
    const latency = (): string | null | undefined =>
      rows()
        .find(
          (r) =>
            r.querySelector(".td-tag")?.textContent === "host_sign_response",
        )
        ?.querySelector(".td-latency")?.textContent;
    expect(latency()).toBe("+50ms");

    // When the reply row is filtered out, the request is evicted, and the
    // reply row is created again
    const exclude = q<HTMLInputElement>(".td-exclude-input");
    type(exclude, "response");
    truapi("noise_receive", "n1");
    truapi("noise_receive", "n2");
    frame();
    type(exclude, "");

    // Then
    expect(latency()).toBe("+50ms");
  });

  it("As a dotli developer, reading scrolled up at capacity keeps the rows under the reader as the head is evicted", () => {
    // Given 20px rows in a 100px list
    mount({ capacity: 50 });
    for (let i = 0; i < 50; i++) {
      truapi("x_receive", `r${String(i)}`);
    }
    frame();
    const list = q(".td-list");
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(
      function (this: HTMLElement) {
        const parent = this.parentElement;
        return this.classList.contains("td-row") && parent !== null
          ? [...parent.children].indexOf(this) * 20
          : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this === list ? this.children.length * 20 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this === list ? 100 : 0;
      },
    );
    list.scrollTop = 200;
    const topRow = rows()[10];

    // When five new events evict the five oldest
    for (let i = 0; i < 5; i++) {
      truapi("x_receive", `n${String(i)}`);
    }
    frame();

    // Then
    expect(rows()[5]).toBe(topRow);
    expect(list.scrollTop).toBe(100);
  });
});

describe("truapi debug panel work: pointer moves", () => {
  it("As a dotli developer, dragging the panel edge reads no layout and refits the app frame once per animation frame", () => {
    // Given
    let heightReads = 0;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        if (this.id !== PANEL_ID) {
          return 0;
        }
        heightReads++;
        return Number.parseFloat(this.style.height || "300");
      },
    );
    vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation(
      () => undefined,
    );
    const appFrame = attachCountingFrame();
    mount();
    pointer(q(".td-resize-handle"), "pointerdown");
    heightReads = 0;
    const writesBefore = appFrame.writes();

    // When five moves land in one frame
    for (let i = 0; i < 5; i++) {
      pointer(q(".td-resize-handle"), "pointermove", 0, 500 + i);
    }

    // Then
    expect(panel().style.height).toBe("264px");
    expect(heightReads).toBe(0);
    expect(appFrame.writes() - writesBefore).toBe(0);

    // When
    frame();

    // Then
    expect(appFrame.writes() - writesBefore).toBe(1);
    expect(appFrame.style.height).toMatch(/ - 264px\)$/);
    pointer(q(".td-resize-handle"), "pointerup");
  });

  it("As a dotli developer, dragging the body splitter measures the body once per drag", () => {
    // Given
    vi.spyOn(HTMLElement.prototype, "setPointerCapture").mockImplementation(
      () => undefined,
    );
    mount();
    let measures = 0;
    q(".td-body").getBoundingClientRect = () => {
      measures++;
      return { left: 10, top: 20, width: 1000, height: 600 } as DOMRect;
    };

    // When
    pointer(q(".td-body-splitter"), "pointerdown");
    pointer(q(".td-body-splitter"), "pointermove", 510, 0);
    pointer(q(".td-body-splitter"), "pointermove", 520, 0);
    pointer(q(".td-body-splitter"), "pointermove", 530, 0);
    pointer(q(".td-body-splitter"), "pointerup");

    // Then
    expect(panel().style.getPropertyValue("--td-left-width")).toBe("520px");
    expect(measures).toBe(1);
  });

  it("As a dotli developer, moving over one timeline box repositions its tooltip without measuring or rewriting it", () => {
    // Given
    mount();
    truapi("host_sign_request", "r1");
    vi.advanceTimersByTime(50);
    truapi("host_sign_response", "r1", "incoming");
    frame();
    click(q('.td-tab[data-view="timeline"]'));
    const box = q(".td-timeline rect.td-tl-segment[data-tooltip]");
    const tooltip = q(".td-tooltip");
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
    pointer(box, "pointerover", 30, 40);
    expect(tooltip.classList.contains("visible")).toBe(true);
    expect(tooltip.style.left).toBe("42px");
    measures = 0;
    let textWrites = 0;
    let proto: object | null = Object.getPrototypeOf(tooltip) as object;
    while (proto !== null && !Object.hasOwn(proto, "textContent")) {
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    const textContent =
      proto === null
        ? undefined
        : Object.getOwnPropertyDescriptor(proto, "textContent");
    Object.defineProperty(tooltip, "textContent", {
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
      pointer(box, "pointermove", 30 + i, 40);
    }

    // Then
    expect(measures).toBe(0);
    expect(textWrites).toBe(0);
    expect(tooltip.style.left).toBe("47px");
    expect(tooltip.textContent).toBe(box.getAttribute("data-tooltip"));
  });
});

describe("truapi debug panel work: keyed row state", () => {
  it("As a dotli developer, evicted rows release their per-row selection and badge entries", () => {
    // Given
    mount({ capacity: 10 });
    for (let i = 0; i < 10; i++) {
      truapi("host_sign_request", `old${String(i)}`);
    }
    frame();
    click(rows()[0]);
    const subscribed = (): string[] =>
      keyedMaps.flatMap((map) => [...map.subscribedKeys()].map(String));
    expect(subscribed().some((k) => k.includes("old"))).toBe(true);

    // When ten new requests evict every row
    for (let i = 0; i < 10; i++) {
      truapi("host_sign_request", `new${String(i)}`);
    }
    frame();

    // Then only the current rows hold entries: a seq, a group key and a
    // pending key each
    const seqs = rows().map((r) => r.dataset.seq ?? "");
    const keys = subscribed();
    expect(keys.filter((k) => k.includes("old"))).toEqual([]);
    expect(keys).toHaveLength(30);
    expect(seqs.every((seq) => keys.includes(seq))).toBe(true);
  });
});
