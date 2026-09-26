// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Hydration of the prerendered host shell. The injected markup is the real
// server output of shell.server.tsx (helpers/shell-ssr.ts), and this file
// runs in the `hydration` vitest project, which compiles components
// hydratable the way the host build does (see vitest.config.ts).

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
import { renderShellOnServer } from "../helpers/shell-ssr";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@dotli/metrics/sentry", () => sentry);

const SHELL_IDS = ["topbar", "auth-button", "theme-toggle", "chat-button"];

function injectShell(html: string): HTMLElement {
  document.body.innerHTML = `<div id="shell" style="display: contents">${html}</div>`;
  return document.getElementById("shell") as HTMLElement;
}

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function hydrationMessages(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((args) => args.map(String).join(" "))
    .filter((message) => /hydrat/i.test(message));
}

/**
 * Whether Solid still processes updates. An error that escapes every
 * boundary halts the whole reactive system, every root on the page.
 */
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

describe("hydrateShell", () => {
  let serverHtml: string;

  beforeAll(async () => {
    serverHtml = await renderShellOnServer();
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

  it("As imperative shell code, the elements I query after hydration are the prerendered nodes themselves, with no hydration warning", async () => {
    // Given
    const { hydrateShell } = await import("@dotli/ui/mount/hydrate-shell");
    const shell = injectShell(serverHtml);
    const before = SHELL_IDS.map(byId);
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");

    // When
    hydrateShell();

    // Then
    expect(before.every((el) => el !== null)).toBe(true);
    expect(SHELL_IDS.map(byId)).toEqual(before);
    for (const [i, el] of before.entries()) {
      expect(byId(SHELL_IDS[i])).toBe(el);
    }
    expect(hydrationMessages(warn)).toEqual([]);
    expect(hydrationMessages(error)).toEqual([]);
    expect(shell.dataset.hydrated).toBe("shell");
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(reactivityRuns()).toBe(true);
  });

  it("As a user, a click handler attached to the auth button after hydration runs when I click it", async () => {
    // Given
    const { hydrateShell } = await import("@dotli/ui/mount/hydrate-shell");
    injectShell(serverHtml);
    hydrateShell();
    const authButton = byId("auth-button") as HTMLButtonElement;
    const onClick = vi.fn();
    authButton.addEventListener("click", onClick);
    // Prerendered as disabled ("Connecting..."); topbar.ts enables it once
    // the auth state is known.
    authButton.disabled = false;

    // When
    authButton.click();

    // Then
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("As a user, prerendered markup that does not match the shell is restored as it was, works, and the mismatch goes to Sentry", async () => {
    // Given
    const { hydrateShell } = await import("@dotli/ui/mount/hydrate-shell");
    // A prerender with a hydration key the client does not know (from
    // another build, say) on the fourth top-level element: the first three
    // are claimed before the miss.
    const staleKey = /_hk=\S+( class="mode-popover-backdrop")/;
    expect(serverHtml).toMatch(staleKey);
    const staleHtml = serverHtml.replace(staleKey, "_hk=stale$1");
    const shell = injectShell(staleHtml);
    const prerendered = shell.innerHTML;
    // Solid's dev build may warn about the key miss; expected here.
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // When
    hydrateShell();

    // Then
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      root: "shell",
      kind: "hydration_failed",
    });
    expect(shell.dataset.hydrated).toBe("fallback");
    expect(shell.innerHTML).toBe(prerendered);
    expect(reactivityRuns()).toBe(true);
    for (const id of [
      ...SHELL_IDS,
      "auth-modal-backdrop",
      "user-popover",
      "mode-popover",
      "permissions-popover",
    ]) {
      expect(shell.querySelectorAll(`#${id}`)).toHaveLength(1);
      expect(document.querySelectorAll(`#${id}`)).toHaveLength(1);
    }
    const authButton = byId("auth-button") as HTMLButtonElement;
    const onClick = vi.fn();
    authButton.addEventListener("click", onClick);
    authButton.disabled = false;
    authButton.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
