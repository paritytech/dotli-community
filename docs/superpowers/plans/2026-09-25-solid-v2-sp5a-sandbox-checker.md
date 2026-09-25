# Solid v2 SP5a — sandbox-checker panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the dev-only sandbox-checker violation panel as a Solid component in `@dotli/ui`, with identical markup, behaviour and copy, and delete the hand-built `sandbox-checker-ui.ts`.

**Architecture:** `packages/ui/src/components/sandbox-checker/ViolationPanel.tsx` renders the panel from local signals; `mount.tsx` exports `mountViolationPanel(iframe)` with the same contract as the old `setupViolationPanel(iframe)`. `bridge.ts` keeps its dynamic, env-gated import and points it at the new module.

**Tech Stack:** Solid 2 RC, `@solidjs/testing-library`, Vitest 5 + happy-dom, TypeScript 6 strict.

**Spec:** `docs/superpowers/specs/2026-09-25-solid-v2-sp5a-sandbox-checker-design.md`.

## Global Constraints

- Branch `feat/solid-v2-foundation`, local only. Never push.
- Markup: `#sandbox-checker-panel` (classes `visible`, `collapsed`), `.sc-resize-handle`, `.sc-header`, `.sc-badge`, `.sc-label` ("API Violations"), `.sc-toggle` (`aria-label="Toggle panel"`, "▼"/"▲"), `.sc-log`, `.sc-entry`, `.sc-time`, `.sc-api`, `.sc-details`. CSS files unchanged.
- Violation fields reach the DOM only as JSX text (no `innerHTML`).
- `packages/sandbox-checker/src/sandbox-checker.ts` and `apps/sandbox/**` unchanged.
- Solid 2 idioms used in this repo: callback refs (`ref={(el) => { x = el; }}`), `class` arrays, `createEffect(compute, effect)`, `onCleanup`, `For`.
- Every commit passes `bun run typecheck`, `bun run lint`, `bun run test`; `bunx prettier --check` on changed `.ts`/`.tsx`.
- Test names: "As a dotli developer, …".

## Review Focus

1. A message from a window other than the product iframe, or with another `type`, must never add an entry. Pinned in Task 1.
2. Markup inside `api` or `details` must render as text. Pinned in Task 1.
3. Disposing must remove the panel, stop listening, and restore the iframe height. Pinned in Task 1.
4. Resizing while collapsed must do nothing. Pinned in Task 1.
5. `bridge.ts` must still dispose the previous panel on re-render. Pinned in Task 2 by keeping `currentPanelDispose` handling untouched.

---

### Task 1: Violation panel component

**Files:**
- Create: `packages/ui/src/components/sandbox-checker/ViolationPanel.tsx`
- Create: `packages/ui/src/components/sandbox-checker/mount.tsx`
- Test: `packages/ui/tests/components/sandbox-checker/violation-panel.test.tsx`

**Interfaces:**
- Produces: `export function mountViolationPanel(iframe: HTMLIFrameElement): () => void` (mount.tsx); `export function ViolationPanel(props: { iframe: HTMLIFrameElement }): JSX.Element`.

- [ ] **Step 1: Write the failing tests**

`packages/ui/tests/components/sandbox-checker/violation-panel.test.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent } from "@solidjs/testing-library";
import { mountViolationPanel } from "@dotli/ui/components/sandbox-checker/mount";
import { settle } from "../../helpers/solid";

let iframe: HTMLIFrameElement;
let dispose: () => void = () => undefined;

function violation(data: unknown, source: MessageEventSource | null = iframe.contentWindow): void {
  window.dispatchEvent(new MessageEvent("message", { data, source }));
}

function panel(): HTMLElement {
  return document.getElementById("sandbox-checker-panel")!;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="topbar"></div>';
  iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  dispose = mountViolationPanel(iframe);
});

afterEach(() => {
  dispose();
  document.body.replaceChildren();
});

describe("sandbox checker violation panel", () => {
  it("As a dotli developer, the panel stays hidden until the first violation, then counts them", async () => {
    // Given
    await settle();

    // Then
    expect(panel().classList.contains("visible")).toBe(false);
    expect(panel().querySelector(".sc-badge")?.textContent).toBe("0");
    expect(panel().querySelector(".sc-label")?.textContent).toBe("API Violations");

    // When
    violation({ type: "DOTLI_API_VIOLATION", api: "localStorage.getItem", details: { key: "x", n: 1 }, timestamp: 0 });
    violation({ type: "DOTLI_API_VIOLATION", api: "fetch", details: {}, timestamp: 0 });
    await settle();

    // Then
    expect(panel().classList.contains("visible")).toBe(true);
    expect(panel().querySelector(".sc-badge")?.textContent).toBe("2");
    const entries = [...panel().querySelectorAll(".sc-entry")];
    expect(entries).toHaveLength(2);
    expect(entries[0].querySelector(".sc-api")?.textContent).toBe("localStorage.getItem");
    expect(entries[0].querySelector(".sc-details")?.textContent).toBe("key=x n=1");
    expect(entries[0].querySelector(".sc-time")?.textContent).toBe(new Date(0).toLocaleTimeString());
    expect(entries[1].querySelector(".sc-details")).toBeNull();
  });

  it("As a dotli developer, markup in a violation shows as text", async () => {
    // When
    violation({ type: "DOTLI_API_VIOLATION", api: "<img src=x onerror=alert(1)>", details: { a: "<b>bold</b>" }, timestamp: 0 });
    await settle();

    // Then
    const entry = panel().querySelector(".sc-entry")!;
    expect(entry.querySelector("img")).toBeNull();
    expect(entry.querySelector("b")).toBeNull();
    expect(entry.querySelector(".sc-api")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(entry.querySelector(".sc-details")?.textContent).toBe("a=<b>bold</b>");
  });

  it("As a dotli developer, messages from other windows or of other types are ignored", async () => {
    // When
    violation({ type: "DOTLI_API_VIOLATION", api: "x", details: {}, timestamp: 0 }, window);
    violation({ type: "SOMETHING_ELSE", api: "x", details: {}, timestamp: 0 });
    violation("not an object");
    await settle();

    // Then
    expect(panel().querySelectorAll(".sc-entry")).toHaveLength(0);
    expect(panel().classList.contains("visible")).toBe(false);
  });

  it("As a dotli developer, showing, collapsing and expanding the panel resizes the app frame", async () => {
    // Given
    violation({ type: "DOTLI_API_VIOLATION", api: "x", details: {}, timestamp: 0 });
    await settle();
    const toggle = panel().querySelector<HTMLButtonElement>(".sc-toggle")!;

    // Then
    expect(toggle.getAttribute("aria-label")).toBe("Toggle panel");
    expect(toggle.textContent).toBe("▼");
    expect(iframe.style.height.startsWith("calc(100dvh - 56px - ")).toBe(true);

    // When
    fireEvent.click(toggle);
    await settle();

    // Then
    expect(panel().classList.contains("collapsed")).toBe(true);
    expect(toggle.textContent).toBe("▲");
    expect(iframe.style.height).toBe("calc(100dvh - 56px - 32px)");

    // When: resizing while collapsed does nothing
    const handle = panel().querySelector<HTMLElement>(".sc-resize-handle")!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(window, { clientY: 100 });
    await settle();

    // Then
    expect(panel().style.height).toBe("");

    // When
    fireEvent.click(toggle);
    await settle();

    // Then
    expect(panel().classList.contains("collapsed")).toBe(false);
    expect(toggle.textContent).toBe("▼");
  });

  it("As a dotli developer, disposing removes the panel, stops listening and restores the frame height", async () => {
    // Given
    violation({ type: "DOTLI_API_VIOLATION", api: "x", details: {}, timestamp: 0 });
    await settle();

    // When
    dispose();
    dispose = () => undefined;
    violation({ type: "DOTLI_API_VIOLATION", api: "y", details: {}, timestamp: 0 });
    await settle();

    // Then
    expect(document.getElementById("sandbox-checker-panel")).toBeNull();
    expect(iframe.style.height).toBe("calc(100dvh - 56px)");
  });
});
```

If happy-dom's `setPointerCapture` throws for synthetic pointer ids, guard the call with `try { … } catch { /* synthetic event */ }` in the component and note it in the report.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --cwd packages/ui test tests/components/sandbox-checker/violation-panel.test.tsx`
Expected: FAIL, cannot resolve `@dotli/ui/components/sandbox-checker/mount`.

- [ ] **Step 3: Write the component and mount**

`packages/ui/src/components/sandbox-checker/ViolationPanel.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Sandbox Checker panel (dev builds with VITE_SANDBOX_CHECKER).
//
// Listens for DOTLI_API_VIOLATION messages from the product iframe and lists
// them in a collapsible panel at the bottom of the viewport. Violation fields
// come from the product, so they only ever render as text.

import { createEffect, createSignal, For, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";

interface Violation {
  id: number;
  time: string;
  api: string;
  details: string;
}

const COLLAPSED_HEIGHT = 32;
const HEADER_AND_HANDLE = 32 + 5;
const MIN_HEIGHT = 40;
const MAX_VIEWPORT_SHARE = 0.8;

function parseViolation(
  raw: unknown,
): { api: string; details: string; timestamp: number } | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const data = raw as {
    type?: unknown;
    api?: unknown;
    details?: unknown;
    timestamp?: unknown;
  };
  if (data.type !== "DOTLI_API_VIOLATION") {
    return null;
  }
  const details =
    typeof data.details === "object" && data.details !== null
      ? Object.entries(data.details as Record<string, unknown>)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(" ")
      : "";
  return {
    api: String(data.api),
    details,
    timestamp: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
  };
}

export function ViolationPanel(props: {
  iframe: HTMLIFrameElement;
}): JSX.Element {
  const [violations, setViolations] = createSignal<Violation[]>([]);
  const [collapsed, setCollapsed] = createSignal(false);
  const [height, setHeight] = createSignal<number | null>(null);
  let panel: HTMLDivElement | undefined;
  let log: HTMLDivElement | undefined;
  let handle: HTMLDivElement | undefined;
  let nextId = 0;
  let dragging = false;
  const topbarOffset = document.getElementById("topbar") !== null ? 56 : 0;

  const adjustIframe = (): void => {
    const panelHeight = collapsed() ? COLLAPSED_HEIGHT : (panel?.offsetHeight ?? 0);
    props.iframe.style.height = `calc(100dvh - ${String(topbarOffset)}px - ${String(panelHeight)}px)`;
  };

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== props.iframe.contentWindow) {
      return;
    }
    const violation = parseViolation(event.data);
    if (violation === null) {
      return;
    }
    setViolations((list) => [
      ...list,
      {
        id: nextId++,
        time: new Date(violation.timestamp).toLocaleTimeString(),
        api: violation.api,
        details: violation.details,
      },
    ]);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    const viewportHeight = window.innerHeight;
    setHeight(
      Math.max(
        MIN_HEIGHT,
        Math.min(viewportHeight - event.clientY, viewportHeight * MAX_VIEWPORT_SHARE),
      ),
    );
  };

  const onPointerUp = (): void => {
    if (!dragging) {
      return;
    }
    dragging = false;
    document.body.style.userSelect = "";
  };

  window.addEventListener("message", onMessage);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  onCleanup(() => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  });

  // New entry: scroll to it. Visible, collapsed or resized: refit the frame.
  createEffect(
    () => violations().length,
    () => {
      if (log !== undefined) {
        log.scrollTop = log.scrollHeight;
      }
    },
  );
  createEffect(
    () => [violations().length > 0, collapsed(), height()] as const,
    ([visible]) => {
      if (visible) {
        adjustIframe();
      }
    },
  );

  return (
    <div
      id="sandbox-checker-panel"
      class={{ visible: violations().length > 0, collapsed: collapsed() }}
      style={{ height: !collapsed() && height() !== null ? `${String(height())}px` : undefined }}
      ref={(el) => {
        panel = el;
      }}
    >
      <div
        class="sc-resize-handle"
        ref={(el) => {
          handle = el;
        }}
        onPointerDown={(event) => {
          if (collapsed() || handle === undefined) {
            return;
          }
          dragging = true;
          handle.setPointerCapture(event.pointerId);
          document.body.style.userSelect = "none";
        }}
      />
      <div class="sc-header">
        <span class="sc-badge">{violations().length}</span>
        <span class="sc-label">API Violations</span>
        <button
          type="button"
          class="sc-toggle"
          aria-label="Toggle panel"
          onClick={() => {
            // Collapsing clears any custom height.
            if (!collapsed()) {
              setHeight(null);
            }
            setCollapsed(!collapsed());
          }}
        >
          {collapsed() ? "▲" : "▼"}
        </button>
      </div>
      <div
        class="sc-log"
        style={{
          "max-height":
            !collapsed() && height() !== null
              ? `${String((height() ?? 0) - HEADER_AND_HANDLE)}px`
              : undefined,
        }}
        ref={(el) => {
          log = el;
        }}
      >
        <For each={violations()}>
          {(entry) => (
            <div class="sc-entry">
              <span class="sc-time">{entry.time}</span>{" "}
              <span class="sc-api">{entry.api}</span>{" "}
              {entry.details !== "" ? <span class="sc-details">{entry.details}</span> : null}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
```

Notes: today's toggle button has no `type`; adding `type="button"` changes nothing (it is not in a form). If `class={{ … }}` object form is rejected by the RC types, use `class={[{ visible: …, collapsed: … }]}`.

`packages/ui/src/components/sandbox-checker/mount.tsx`:

```tsx
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imported dynamically by bridge.ts, only in VITE_SANDBOX_CHECKER builds.

import { disposeRoot, mountRoot } from "../../mount/root";
import { ViolationPanel } from "./ViolationPanel";

const ROOT = "sandbox-checker";

/** Show the violation panel for `iframe`. Returns the dispose function. */
export function mountViolationPanel(iframe: HTMLIFrameElement): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  mountRoot(ROOT, container, () => <ViolationPanel iframe={iframe} />);
  return () => {
    disposeRoot(ROOT);
    container.remove();
    iframe.style.height =
      document.getElementById("topbar") !== null ? "calc(100dvh - 56px)" : "100dvh";
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run --cwd packages/ui test tests/components/sandbox-checker/violation-panel.test.tsx`
Expected: 5 passed.

Run: `bun run --cwd packages/ui typecheck && bun run --cwd packages/ui lint && bun run --cwd packages/ui test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
bunx prettier --write packages/ui/src/components/sandbox-checker/ViolationPanel.tsx packages/ui/src/components/sandbox-checker/mount.tsx packages/ui/tests/components/sandbox-checker/violation-panel.test.tsx
git add packages/ui/src/components/sandbox-checker/ViolationPanel.tsx packages/ui/src/components/sandbox-checker/mount.tsx packages/ui/tests/components/sandbox-checker/violation-panel.test.tsx
git commit -m "feat(ui): add Solid sandbox-checker violation panel"
```

---

### Task 2: Switch the bridge to the Solid panel and delete the old one

**Files:**
- Modify: `packages/ui/src/bridge.ts` (the two `import("@dotli/sandbox-checker/sandbox-checker-ui")` sites, around lines 1055 and 1226)
- Delete: `packages/sandbox-checker/src/sandbox-checker-ui.ts`

**Interfaces:**
- Consumes: `mountViolationPanel(iframe: HTMLIFrameElement): () => void` (Task 1).

- [ ] **Step 1: Point both import sites at the new module**

At each of the two sites in `packages/ui/src/bridge.ts`, replace

```ts
    const { setupViolationPanel } =
      await import("@dotli/sandbox-checker/sandbox-checker-ui");
```

with

```ts
    const { mountViolationPanel } =
      await import("./components/sandbox-checker/mount");
```

and `currentPanelDispose = setupViolationPanel(host.iframe);` with `currentPanelDispose = mountViolationPanel(host.iframe);`. Leave the surrounding `VITE_SANDBOX_CHECKER` check, the render-generation guard and every use of `currentPanelDispose` unchanged.

- [ ] **Step 2: Delete the old panel**

```bash
git rm packages/sandbox-checker/src/sandbox-checker-ui.ts
```

Run: `git grep -n "sandbox-checker-ui\|setupViolationPanel" -- apps packages`
Expected: no output.

- [ ] **Step 3: Verify**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass (the `@dotli/sandbox-checker` package still typechecks and lints with only `sandbox-checker.ts`).

Run: `VITE_SANDBOX_CHECKER=1 VITE_NETWORKS=paseo-next-v2,previewnet bun run build`
Expected: builds; `grep -l "sandbox-checker-panel" apps/host/dist/assets/*.js` lists a lazily loaded chunk (not the entry `index-*.js`). Then rebuild without the variable (`VITE_NETWORKS=paseo-next-v2,previewnet bun run build`) and confirm `grep -l "sandbox-checker-panel" apps/host/dist/assets/*.js` finds nothing or only a lazy chunk, and `bun scripts/eager-path-size.ts apps/host/dist` is unchanged versus the build before this task (±50 B).

- [ ] **Step 4: Commit**

```bash
bunx prettier --write packages/ui/src/bridge.ts
git add packages/ui/src/bridge.ts
git commit -m "refactor(ui): load the Solid sandbox-checker panel from the bridge"
```

(The `git rm` above is already staged.)
