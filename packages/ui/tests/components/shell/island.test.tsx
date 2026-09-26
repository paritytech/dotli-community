// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A shell island (components/shell/Island.tsx) inside a static, template-
// stripped shell: it hydrates with the shell, keeps working after hydration,
// and an error it raises blanks only itself. The shell is a look-alike
// fixture (tests/mount/fixtures/IslandShell.tsx) with the real server output
// (helpers/shell-ssr.ts); this file runs in the `hydration` vitest project,
// which compiles it hydratable and strips its templates the way the host
// build treats Shell.tsx (see vitest.config.ts).

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createEffect, createRoot, createSignal, flush } from "solid-js";
import { renderOnServer } from "../../helpers/shell-ssr";
import {
  ISLAND_SHELL_RENDER_ID,
  IslandShell,
} from "../../mount/fixtures/IslandShell";
import { breakMountedCounter } from "../../mount/fixtures/Counter";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

const SERVER_ENTRY = "tests/mount/fixtures/island-shell.server.tsx";
const ISLAND_SHELL = "tests/mount/fixtures/IslandShell.tsx";
let serverHtml = "";

const IDS = [
  "fixture-bar",
  "fixture-home",
  "fixture-counter",
  "fixture-after",
  "fixture-panel",
];

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function injectFixture(): void {
  document.body.innerHTML = `<div id="shell">${serverHtml}</div>`;
}

function hydrationMessages(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((args) => args.map(String).join(" "))
    .filter((message) => /hydrat/i.test(message));
}

/** Whether Solid still processes updates (see hydrate-shell.test.tsx). */
function reactivityRuns(): boolean {
  let seen = -1;
  const [count, setCount] = createSignal(0);
  const dispose = createRoot((disposeRoot) => {
    createEffect(count, (value) => {
      seen = value;
    });
    return disposeRoot;
  });
  flush();
  setCount(1);
  flush();
  dispose();
  return seen === 1;
}

describe("Island", () => {
  beforeAll(async () => {
    serverHtml = await renderOnServer(SERVER_ENTRY, "renderIslandShell", [
      ISLAND_SHELL,
    ]);
  });

  beforeEach(() => {
    sentry.captureException.mockClear();
    delete (globalThis as { _$HY?: unknown })._$HY;
  });

  afterEach(async () => {
    const { disposeRoot } = await import("@dotli/ui/mount/root");
    disposeRoot("shell");
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  async function hydrateFixture(): Promise<HTMLElement> {
    const { hydrateRoot } = await import("@dotli/ui/mount/root");
    const container = byId("shell") as HTMLElement;
    const { hydrated } = hydrateRoot(
      "shell",
      container,
      () => <IslandShell />,
      {
        renderId: ISLAND_SHELL_RENDER_ID,
      },
    );
    expect(hydrated).toBe(true);
    return container;
  }

  it("As a user, an island hydrates in place with the static shell around it, with no hydration warning, and reacts after hydration", async () => {
    // Given
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    injectFixture();
    const before = IDS.map(byId);
    expect(before.every((el) => el !== null)).toBe(true);
    const counter = byId("fixture-counter") as HTMLButtonElement;
    expect(counter.textContent).toBe("0");

    // When
    await hydrateFixture();
    counter.click();
    flush();

    // Then
    for (const [i, el] of before.entries()) {
      expect(byId(IDS[i])).toBe(el);
    }
    expect(counter.textContent).toBe("1");
    expect(hydrationMessages(warn)).toEqual([]);
    expect(hydrationMessages(error)).toEqual([]);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("As a user, an island that breaks after hydration disappears alone, the error goes to Sentry once, and the rest of the shell keeps working", async () => {
    // Given
    injectFixture();
    const container = await hydrateFixture();
    const bar = byId("fixture-bar");
    const after = byId("fixture-after");
    const panel = byId("fixture-panel");

    // When
    breakMountedCounter();
    flush();

    // Then
    expect(byId("fixture-counter")).toBeNull();
    expect(byId("fixture-bar")).toBe(bar);
    expect(byId("fixture-after")).toBe(after);
    expect(byId("fixture-panel")).toBe(panel);
    expect(container.contains(bar)).toBe(true);
    // The report is sent once Sentry's module has loaded (Island.tsx).
    await vi.waitFor(() => {
      expect(sentry.captureException).toHaveBeenCalled();
    });
    flush();
    await Promise.resolve();
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(
      new Error("the counter island broke"),
      { root: "shell", island: "counter" },
    );
    expect(reactivityRuns()).toBe(true);
  });

  it("As the test setup, the shell look-alike is compiled without its templates, like Shell.tsx, so it can only be hydrated", async () => {
    // Given
    const { disposeRoot, mountRoot } = await import("@dotli/ui/mount/root");
    const container = document.createElement("div");
    document.body.append(container);

    // When
    mountRoot("island-strip-probe", container, () => <IslandShell />);
    disposeRoot("island-strip-probe");

    // Then
    expect(container.innerHTML).toBe("");
    // A stripped template leaves Solid nothing to create the nodes from
    // (see mount/strip-client-templates-plugin.ts).
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/^Hydration Mismatch/) as string,
      }),
      { root: "island-strip-probe" },
    );
  });
});
