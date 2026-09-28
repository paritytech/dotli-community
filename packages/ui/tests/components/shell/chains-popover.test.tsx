// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush } from "solid-js";
import type {
  BlockBar,
  ChainStatus,
  TransferState,
} from "@dotli/ui/network-monitor";
import { ChainsPopover } from "@dotli/ui/components/shell/ChainsPopover";
import { mountRoot } from "@dotli/ui/mount/root";
import { startNetworkStore } from "@dotli/ui/state/network";
import { setProductLoaded } from "@dotli/ui/state/product";
import {
  recordChainsButtonVisible,
  setBlockingModalActive,
} from "@dotli/ui/state/topbar";
import {
  pointerPress,
  pointerPressUnfocusable,
  renderComponent,
  resetStores,
  tabTo,
} from "../../helpers/solid";
import { normalized } from "./old-auth-markup";
import { oldChainsButton, oldChainsPopover } from "./old-chains-markup";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

/** The verdict, counted as the popover computes it. */
const format = vi.hoisted(() => ({ describeLiveNetwork: vi.fn() }));
vi.mock("@dotli/ui/components/shell/chains-format", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@dotli/ui/components/shell/chains-format")
    >();
  format.describeLiveNetwork.mockImplementation(actual.describeLiveNetwork);
  return { ...actual, describeLiveNetwork: format.describeLiveNetwork };
});

/** The network monitor, as a test drives it. */
const monitor = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  status: [] as unknown[],
  transfer: { bytesPerSecond: null, fetched: null, total: null } as TransferState,
  startNetworkWatch: () => undefined,
  stopNetworkWatch: () => undefined,
}));

vi.mock("@dotli/ui/network-monitor", () => ({
  subscribeNetwork: (l: () => void) => {
    monitor.listeners.add(l);
    return () => monitor.listeners.delete(l);
  },
  getNetworkStatus: () => monitor.status,
  getTransfer: () => monitor.transfer,
  startNetworkWatch: () => {
    monitor.startNetworkWatch();
  },
  stopNetworkWatch: () => {
    monitor.stopNetworkWatch();
  },
}));

const NO_TRANSFER: TransferState = {
  bytesPerSecond: null,
  fetched: null,
  total: null,
};

function chain(overrides: Partial<ChainStatus> = {}): ChainStatus {
  return {
    role: "relay",
    label: "Relay chain",
    bars: [],
    latest: null,
    sinceLast: null,
    blockTimeMs: 6000,
    reachable: true,
    phase: null,
    peers: null,
    ...overrides,
  };
}

function bars(from: number, count: number, gapMs = 6000): BlockBar[] {
  return Array.from({ length: count }, (_, i) => ({
    number: from + i,
    health: gapMs > 18_000 ? "veryLate" : gapMs > 9000 ? "late" : "onTime",
    gapMs,
  }));
}

/** The monitor changed: tell whoever listens, as it does. */
function notify(): void {
  for (const listener of [...monitor.listeners]) {
    listener();
  }
}

let stopStore: () => void = () => undefined;
let cleanups: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  monitor.status = [];
  monitor.transfer = NO_TRANSFER;
  monitor.startNetworkWatch = vi.fn();
  monitor.stopNetworkWatch = vi.fn();
  sentry.captureException.mockClear();
  stopStore = startNetworkStore();
});

afterEach(() => {
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups = [];
  stopStore();
  monitor.listeners.clear();
  resetStores();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function settle(): Promise<void> {
  flush();
  await Promise.resolve();
  flush();
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function isOpen(): boolean {
  return byId("chains-popover").classList.contains("open");
}

function press(key: string): void {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

async function renderPopover(): Promise<void> {
  const { unmount } = renderComponent(() => (
    <div>
      <ChainsPopover />
      <button id="outside" type="button">
        Outside
      </button>
    </div>
  ));
  cleanups.push(unmount);
  await settle();
}

async function openPopover(): Promise<void> {
  byId("chains-button").click();
  await settle();
  expect(isOpen()).toBe(true);
}

function waitingText(): string | null | undefined {
  return document.querySelector(".chains-bars-waiting")?.textContent;
}

describe("The network popover island", () => {
  it("As a dotli user, the closed button and popover match what the topbar rendered", async () => {
    // When
    await renderPopover();

    // Then
    expect(
      normalized(byId("chains-button")).isEqualNode(
        normalized(oldChainsButton({ open: false, visible: false })),
      ),
    ).toBe(true);
    expect(
      normalized(byId("chains-popover")).isEqualNode(
        normalized(oldChainsPopover({ open: false })),
      ),
    ).toBe(true);
  });

  const statuses: {
    name: string;
    chains: ChainStatus[];
    transfer?: TransferState;
    productLoaded?: boolean;
  }[] = [
    {
      name: "starting, with no chain reachable",
      chains: [
        chain({ reachable: false }),
        chain({ role: "assethub", label: "Asset Hub", reachable: false }),
      ],
    },
    {
      name: "connecting, before any block or phase",
      chains: [chain(), chain({ role: "assethub", label: "Asset Hub" })],
      transfer: { bytesPerSecond: 512, fetched: 2048, total: 4_194_304 },
    },
    {
      name: "connecting, a chain syncing and one without an endpoint",
      chains: [
        chain({ phase: "syncing", peers: 1 }),
        chain({ role: "people", label: "People", reachable: false, peers: 3 }),
      ],
      transfer: {
        bytesPerSecond: 2_500_000,
        fetched: 3_000_000,
        total: 3_000_000,
      },
    },
    {
      name: "one of two ready, the other counting down to its next block",
      chains: [
        chain({ latest: 10, sinceLast: 1500, peers: 4 }),
        chain({
          role: "assethub",
          label: "Asset Hub",
          latest: 20,
          bars: bars(18, 3),
          sinceLast: 1000,
          peers: 8,
        }),
        chain({ role: "people", label: "People" }),
      ],
      transfer: { bytesPerSecond: 40_000, fetched: null, total: null },
    },
    {
      name: "waiting on overdue chains, one of them due any moment",
      chains: [
        chain({ latest: 10, sinceLast: 19_000 }),
        chain({
          role: "assethub",
          label: "Asset Hub",
          latest: 20,
          bars: [
            ...bars(18, 2),
            ...bars(20, 1, 12_000),
            ...bars(21, 1, 30_000),
          ],
          sinceLast: 20_000,
        }),
      ],
    },
    {
      name: "a good connection, after the product loaded",
      chains: [
        chain({ latest: 10, bars: bars(8, 3), sinceLast: 500, peers: 12 }),
        chain({
          role: "assethub",
          label: "Asset Hub",
          latest: 20,
          bars: bars(18, 3, 4000),
          sinceLast: 200,
          peers: 1,
        }),
      ],
      transfer: { bytesPerSecond: 800, fetched: 4096, total: 4096 },
      productLoaded: true,
    },
  ];

  for (const status of statuses) {
    it(`As a dotli user opening it (${status.name}), it matches what the topbar rendered`, async () => {
      // Given
      monitor.status = status.chains;
      monitor.transfer = status.transfer ?? NO_TRANSFER;
      notify();
      if (status.productLoaded === true) {
        setProductLoaded("app.dot", "app.dot");
      }
      await renderPopover();

      // When
      await openPopover();

      // Then
      expect(
        normalized(byId("chains-button")).isEqualNode(
          normalized(oldChainsButton({ open: true, visible: false })),
        ),
      ).toBe(true);
      expect(
        normalized(byId("chains-popover")).isEqualNode(
          normalized(
            oldChainsPopover({
              open: true,
              chains: status.chains,
              transfer: status.transfer ?? NO_TRANSFER,
              productLoaded: status.productLoaded === true,
            }),
          ),
        ),
      ).toBe(true);
    });
  }

  it("As a dotli user, opening it starts watching the chains and closing it lets the watch lapse", async () => {
    // Given
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(monitor.startNetworkWatch).toHaveBeenCalledTimes(1);
    expect(monitor.stopNetworkWatch).not.toHaveBeenCalled();

    // When
    byId("chains-button").click();
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(monitor.stopNetworkWatch).toHaveBeenCalledTimes(1);
  });

  it("As a dotli user watching, bars and peers follow the network store", async () => {
    // Given
    monitor.status = [chain({ latest: 10, sinceLast: 0 })];
    notify();
    await renderPopover();
    await openPopover();
    expect(document.querySelectorAll(".chains-bar[data-block]")).toHaveLength(
      0,
    );

    // When
    monitor.status = [
      chain({ latest: 12, bars: bars(11, 2), sinceLast: 0, peers: 2 }),
    ];
    notify();
    await settle();

    // Then
    expect(
      [
        ...document.querySelectorAll<HTMLElement>(".chains-bar[data-block]"),
      ].map((m) => m.dataset.block),
    ).toEqual(["11", "12"]);
    expect(document.querySelector(".chains-group-peers")?.textContent).toBe(
      "2 peers",
    );
    expect(document.querySelector(".chains-status")?.textContent).toBe(
      "Your connection is good",
    );
  });

  it("As a dotli user watching a chain between blocks, the countdown ticks while the popover is open and stops when it closes", async () => {
    // Given
    monitor.status = [chain({ latest: 10, sinceLast: 1000 })];
    notify();
    await renderPopover();
    await openPopover();
    expect(waitingText()).toBe("next block in about 5s");

    // When
    vi.advanceTimersByTime(1000);
    await settle();

    // Then
    expect(waitingText()).toBe("next block in about 4s");
    expect(vi.getTimerCount()).toBe(1);

    // When
    byId("chains-button").click();
    await settle();

    // Then
    expect(vi.getTimerCount()).toBe(0);
  });

  it("As a dotli user, the countdown stops when the island unmounts while open", async () => {
    // Given
    monitor.status = [chain({ latest: 10, sinceLast: 1000 })];
    notify();
    await renderPopover();
    await openPopover();
    expect(vi.getTimerCount()).toBe(1);

    // When
    for (const cleanup of cleanups) {
      cleanup();
    }
    cleanups = [];

    // Then
    expect(vi.getTimerCount()).toBe(0);
    expect(monitor.stopNetworkWatch).toHaveBeenCalledTimes(1);
  });

  it("As a dotli user, a render error while open is reported, closes the popover and stops the countdown and the watch", async () => {
    // Given: the island in its root, as islands.tsx mounts it.
    monitor.status = [chain({ latest: 10, sinceLast: 1000 })];
    notify();
    const container = document.createElement("div");
    document.body.appendChild(container);
    cleanups.push(
      mountRoot("island:chains-test", container, () => <ChainsPopover />),
    );
    await settle();
    byId("chains-button").click();
    await settle();
    expect(isOpen()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    // When: rendering the next network state throws.
    monitor.status = [
      Object.defineProperty(chain({ latest: 11, sinceLast: 0 }), "label", {
        get: () => {
          throw new Error("the island broke");
        },
      }),
    ];
    notify();
    await settle();

    // Then
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      root: "island:chains",
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(monitor.stopNetworkWatch).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(false);

    // When: the next open, once the state renders again.
    monitor.status = [chain({ latest: 11, sinceLast: 0 })];
    notify();
    byId("chains-button").click();
    await settle();

    // Then
    expect(isOpen()).toBe(true);
    expect(document.querySelector(".chains-group-label")?.textContent).toBe(
      "Relay chain",
    );
    expect(vi.getTimerCount()).toBe(1);
  });

  it("As a visitor watching the product download, the transfer footer empties once the product has loaded", async () => {
    // Given
    monitor.transfer = { bytesPerSecond: 2048, fetched: 1024, total: 4096 };
    notify();
    await renderPopover();
    await openPopover();
    const rows = (): string[] =>
      [...document.querySelectorAll(".chains-transfer-row")].map(
        (row) => row.textContent ?? "",
      );
    expect(rows()).toEqual(["Speed2 kB/s", "Downloading1 kB / 4 kB"]);

    // When
    setProductLoaded("app.dot", "app.dot");
    await settle();

    // Then
    expect(rows()).toEqual(["", ""]);
  });

  it("As a keyboard user, opening it focuses the popover and Escape closes it, handing focus back to the button", async () => {
    // Given
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(document.activeElement).toBe(byId("chains-popover"));
    expect(byId("chains-button").getAttribute("aria-expanded")).toBe("true");

    // When
    press("Escape");
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(byId("chains-button").getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(byId("chains-button"));
  });

  it("As a screen-reader user, the button announces the dialog it opens and whether it is open", async () => {
    // Given
    await renderPopover();
    const button = byId("chains-button");
    const popover = byId("chains-popover");

    // Then
    expect(popover.getAttribute("role")).toBe("dialog");
    expect(popover.getAttribute("aria-label")).toBe("Network");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-controls")).toBe("chains-popover");
    expect(button.getAttribute("aria-expanded")).toBe("false");

    // When
    await openPopover();

    // Then
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("As a keyboard user, Tab out of the popover closes it and focus moves on", async () => {
    // Given
    await renderPopover();
    byId("chains-button").focus();
    await openPopover();
    expect(byId("chains-popover").contains(document.activeElement)).toBe(true);

    // When
    const tab = tabTo(byId("outside"));
    await settle();

    // Then
    expect(tab.defaultPrevented).toBe(false);
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byId("outside"));
  });

  it("As a dotli user, a press outside closes it without handing focus back to the button", async () => {
    // Given
    await renderPopover();
    byId("chains-button").focus();
    await openPopover();

    // When: the press lands on nothing that takes focus.
    pointerPressUnfocusable(document.body);
    await settle();

    // Then: focus follows the press.
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("As a dotli user, a click outside closes it, and a click inside does not", async () => {
    // Given
    await renderPopover();
    await openPopover();

    // When
    (document.querySelector(".chains-tips") as HTMLElement).click();
    await settle();

    // Then
    expect(isOpen()).toBe(true);

    // When
    pointerPress(byId("outside"));
    await settle();

    // Then
    expect(isOpen()).toBe(false);
  });

  it("As a dotli user, a blocking modal coming up closes it, stopping the countdown and the network watch", async () => {
    // Given
    monitor.status = [chain({ latest: 10, sinceLast: 1000 })];
    notify();
    await renderPopover();
    await openPopover();
    expect(vi.getTimerCount()).toBe(1);
    expect(monitor.stopNetworkWatch).not.toHaveBeenCalled();

    // When
    setBlockingModalActive(true);
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(monitor.stopNetworkWatch).toHaveBeenCalledTimes(1);
  });

  it("As a visitor, the button shows once the product is on screen, whether that came before or after the mount", async () => {
    // Given: revealed before the island mounted.
    recordChainsButtonVisible(true);

    // When
    await renderPopover();

    // Then
    expect(
      normalized(byId("chains-button")).isEqualNode(
        normalized(oldChainsButton({ open: false, visible: true })),
      ),
    ).toBe(true);

    // When
    recordChainsButtonVisible(false);
    await settle();

    // Then
    expect(byId("chains-button").classList.contains("visible")).toBe(false);
  });
});

describe("The network popover island, on network updates", () => {
  /** A stand-in ResizeObserver whose callbacks a test fires. */
  let resizeCallbacks: (() => void)[] = [];
  /** The width the bar strips lay out at. */
  let stripWidth = 0;

  beforeEach(() => {
    resizeCallbacks = [];
    stripWidth = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
        }
        observe(): void {
          resizeCallbacks.push(this.callback);
        }
        unobserve(): void {}
        disconnect(): void {
          resizeCallbacks = resizeCallbacks.filter(
            (cb) => cb !== this.callback,
          );
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Strips lay out `stripWidth` wide; 4px bars with 4px gaps. */
  function spyStripLayout(): {
    rects: ReturnType<typeof vi.spyOn>;
    styles: ReturnType<typeof vi.spyOn>;
  } {
    const rects = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const width = this.classList.contains("chains-bars") ? stripWidth : 0;
        return { width, height: 0 } as DOMRect;
      });
    const styles = vi.spyOn(window, "getComputedStyle");
    return { rects, styles };
  }

  function shownBlocks(): string[] {
    return [
      ...document.querySelectorAll<HTMLElement>(".chains-bar[data-block]"),
    ].map((bar) => bar.dataset.block ?? "");
  }

  it("As a dotli user watching the download, updates that land no block read no layout", async () => {
    // Given
    stripWidth = 76;
    const strip = bars(1, 10);
    monitor.status = [chain({ latest: 10, bars: strip, sinceLast: 0 })];
    notify();
    await renderPopover();
    await openPopover();
    const { rects, styles } = spyStripLayout();

    // When: five speed samples, the same bars each time.
    for (let i = 0; i < 5; i += 1) {
      monitor.transfer = {
        bytesPerSecond: 1000 + i,
        fetched: null,
        total: null,
      };
      monitor.status = [chain({ latest: 10, bars: [...strip], sinceLast: 0 })];
      notify();
      await settle();
    }

    // Then
    expect(rects).toHaveBeenCalledTimes(0);
    expect(styles).toHaveBeenCalledTimes(0);
    expect(shownBlocks()).toHaveLength(10);
  });

  it("As a dotli user, the strip shows the bars that fit as it opens, and more once it widens", async () => {
    // Given: 20 bars; the strip fits 10 of them.
    spyStripLayout();
    stripWidth = 76;
    monitor.status = [chain({ latest: 20, bars: bars(1, 20), sinceLast: 0 })];
    notify();
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(shownBlocks()).toEqual(
      Array.from({ length: 10 }, (_, i) => String(11 + i)),
    );

    // When: the panel widens to fit all 20, with no network update.
    stripWidth = 156;
    for (const callback of resizeCallbacks) {
      callback();
    }
    await settle();

    // Then: the older bars are revealed, not slid in as new blocks.
    expect(shownBlocks()).toHaveLength(20);
    expect(document.querySelectorAll(".chains-bar.is-new")).toHaveLength(0);
  });

  it("As a dotli user watching a chain between blocks, the countdown is computed once per tick", async () => {
    // Given
    let reads = 0;
    const pending = Object.defineProperty(
      chain({ latest: 10, sinceLast: 1000 }),
      "blockTimeMs",
      {
        get: () => {
          reads += 1;
          return 6000;
        },
      },
    );
    monitor.status = [pending];
    notify();
    await renderPopover();
    await openPopover();
    reads = 0;

    // When
    vi.advanceTimersByTime(250);
    await settle();

    // Then: one computation reads the block time twice.
    expect(reads).toBe(2);
    expect(waitingText()).toBe("next block in about 5s");
  });

  it("As a dotli user, the verdict is worked out once per network update", async () => {
    // Given
    monitor.status = [chain({ latest: 10, bars: bars(1, 10), sinceLast: 0 })];
    notify();
    await renderPopover();
    await openPopover();
    format.describeLiveNetwork.mockClear();

    // When
    monitor.status = [chain({ latest: 11, bars: bars(1, 11), sinceLast: 0 })];
    notify();
    await settle();

    // Then
    expect(format.describeLiveNetwork).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".chains-status")?.textContent).toBe(
      "Your connection is good",
    );
  });

  it("As a dotli user, the countdown ticker stops once no chain is waiting for its first block", async () => {
    // Given
    monitor.status = [chain({ latest: 10, sinceLast: 1000 })];
    notify();
    await renderPopover();
    await openPopover();
    expect(vi.getTimerCount()).toBe(1);

    // When
    monitor.status = [chain({ latest: 11, bars: bars(11, 1), sinceLast: 0 })];
    notify();
    await settle();

    // Then
    expect(vi.getTimerCount()).toBe(0);
    expect(shownBlocks()).toEqual(["11"]);
  });

  it("As a dotli user opening it with every chain showing bars, no countdown ticker runs", async () => {
    // Given
    monitor.status = [chain({ latest: 10, bars: bars(1, 10), sinceLast: 0 })];
    notify();
    await renderPopover();

    // When
    await openPopover();

    // Then
    expect(vi.getTimerCount()).toBe(0);
  });
});
