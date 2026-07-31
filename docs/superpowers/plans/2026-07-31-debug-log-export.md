# Debug Log Export & Copy JSON Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Export (JSON file download) and Copy (clipboard) buttons to the TrUAPI debug panel that serialize the currently filtered events at full fidelity.

**Architecture:** A new pure, DOM-free serialization module (`export.ts`) builds a self-describing JSON document (meta envelope + events). The panel toolbar gains two buttons wired in `wireHeader`, filtering via the existing `matches()` predicate. Spec: `docs/superpowers/specs/2026-07-31-debug-log-export-design.md`.

**Tech Stack:** TypeScript, vanilla DOM (no framework), Blob download, `navigator.clipboard`. No new dependencies.

## Global Constraints

- **No tests.** `packages/truapi-debug` is intentionally test-free (project convention). Verification is typecheck + lint + manual run.
- **No commits.** Vale commits and ships themself — never run `git add`/`git commit`.
- New files start with the two-line license header:
  `// Copyright 2026 Parity Technologies (UK) Ltd.` / `// SPDX-License-Identifier: AGPL-3.0-only`
- Match existing style: `.ts` import specifiers, `type`-only imports, JSDoc on exported symbols.
- Verification commands (run from repo root):
  - `bun run --cwd packages/truapi-debug typecheck`
  - `bun run --cwd packages/truapi-debug lint`

---

### Task 1: Pure export module (`export.ts`)

**Files:**
- Modify: `packages/truapi-debug/src/format.ts:20` (export `isUint8ArrayLike`)
- Create: `packages/truapi-debug/src/export.ts`

**Interfaces:**
- Consumes: `StoredEvent` from `./event-store.ts`, `FilterState` from `./filters.ts`, `toHex` from `@dotli/shared/hex`, `isUint8ArrayLike` from `./format.ts`.
- Produces (used by Task 2):
  - `interface ExportMeta { exportedAt: string; url: string; userAgent: string; capacity: number; droppedCount: number; totalEvents: number; exportedEvents: number; filters: FilterState }`
  - `buildExport(events: readonly StoredEvent[], meta: ExportMeta): string`
  - `exportFilename(now: Date): string`

- [ ] **Step 1: Export `isUint8ArrayLike` from format.ts**

In `packages/truapi-debug/src/format.ts`, change line 20 from:

```ts
function isUint8ArrayLike(v: unknown): v is Uint8Array {
```

to:

```ts
export function isUint8ArrayLike(v: unknown): v is Uint8Array {
```

Leave everything else in the file untouched (the display replacer keeps its truncation).

- [ ] **Step 2: Create `packages/truapi-debug/src/export.ts`**

```ts
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// TrUAPI debug export
//
// Pure serialization of stored debug events for file download and
// clipboard copy. Unlike format.ts (display-oriented, truncated
// previews), output here is full fidelity: complete hex for
// Uint8Array, whole strings. No DOM in this module.

import { toHex } from "@dotli/shared/hex";

import type { StoredEvent } from "./event-store.ts";
import type { FilterState } from "./filters.ts";
import { isUint8ArrayLike } from "./format.ts";

/** Context block written alongside the events so an exported file is
 *  self-describing: what page produced it, how full the ring buffer
 *  was, and which filters were active (exports are filtered views). */
export interface ExportMeta {
  exportedAt: string;
  url: string;
  userAgent: string;
  capacity: number;
  droppedCount: number;
  totalEvents: number;
  exportedEvents: number;
  filters: FilterState;
}

/**
 * Full-fidelity JSON.stringify replacer:
 * - Uint8Array becomes { __type: "Uint8Array", length, hex } with the
 *   COMPLETE hex string (no preview cap)
 * - bigint becomes a string with trailing "n"
 * - cycles become "[Circular]"
 * - strings are never truncated
 */
function makeExportReplacer(): (
  this: unknown,
  k: string,
  v: unknown,
) => unknown {
  const seen = new WeakSet();
  return function replacer(_k, v) {
    if (typeof v === "bigint") {
      return `${v.toString()}n`;
    }
    if (isUint8ArrayLike(v)) {
      return { __type: "Uint8Array", length: v.length, hex: toHex(v) };
    }
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) {
        return "[Circular]";
      }
      seen.add(v);
    }
    return v;
  };
}

/**
 * Serialize events + meta to pretty-printed JSON. Never throws: if an
 * exotic payload defeats the replacer, the result is still a valid
 * JSON document with an `error` field in place of `events`.
 */
export function buildExport(
  events: readonly StoredEvent[],
  meta: ExportMeta,
): string {
  try {
    return JSON.stringify({ meta, events }, makeExportReplacer(), 2);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return JSON.stringify(
      { meta, error: `serialization failed: ${reason}` },
      makeExportReplacer(),
      2,
    );
  }
}

/** `dotli-debug-2026-07-31T14-30-00.json` — ISO timestamp with `:`
 *  swapped for `-` (Windows-safe filename). */
export function exportFilename(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, "-");
  return `dotli-debug-${stamp}.json`;
}
```

Note the fallback path also uses `makeExportReplacer()`: `meta.filters` can contain `undefined` (`product`), which plain stringify drops silently — same behavior either way, but keeping one replacer avoids surprises if meta ever grows richer fields.

- [ ] **Step 3: Typecheck and lint**

Run: `bun run --cwd packages/truapi-debug typecheck && bun run --cwd packages/truapi-debug lint`
Expected: both pass with no errors.

---

### Task 2: Panel toolbar buttons and wiring

**Files:**
- Modify: `packages/truapi-debug/src/event-store.ts:63` (make `capacity` public)
- Modify: `packages/truapi-debug/src/panel.ts` (toolbar HTML ~line 270, `PanelUI` ~line 243, `buildPanel` queries ~line 322, `wireHeader` ~line 369)

**Interfaces:**
- Consumes: `buildExport`, `exportFilename`, `ExportMeta` from `./export.ts` (Task 1); `matches` from `./filters.ts` (already imported in panel.ts); `store.list()`, `store.dropped()`, `store.capacity`.
- Produces: user-facing Export/Copy buttons; no new exports.

- [ ] **Step 1: Expose `capacity` on EventStore**

In `packages/truapi-debug/src/event-store.ts`, change:

```ts
  private readonly capacity: number;
```

to:

```ts
  /** Configured ring-buffer cap; exposed for export metadata. */
  readonly capacity: number;
```

- [ ] **Step 2: Add the buttons to the header HTML**

In `panel.ts` `buildPanel`, after the Clear button line
(`<button class="td-btn td-clear" type="button">Clear</button>`), insert:

```html
      <button class="td-btn td-export" type="button" title="Download filtered events as JSON">Export</button>
      <button class="td-btn td-copy" type="button" title="Copy filtered events as JSON">Copy</button>
```

They reuse the existing `.td-btn` styling — no CSS changes needed.

- [ ] **Step 3: Add the buttons to `PanelUI` and the query block**

In the `PanelUI` interface, after `clearBtn: HTMLButtonElement;` add:

```ts
  exportBtn: HTMLButtonElement;
  copyBtn: HTMLButtonElement;
```

In the `ui` object literal in `buildPanel`, after the `clearBtn` entry add:

```ts
    exportBtn: panel.querySelector(".td-export") as HTMLButtonElement,
    copyBtn: panel.querySelector(".td-copy") as HTMLButtonElement,
```

(Inside the existing `eslint-disable @typescript-eslint/non-nullable-type-assertion-style` block — match the surrounding pattern.)

- [ ] **Step 4: Add imports and helpers to panel.ts**

Add to the imports at the top of `panel.ts`:

```ts
import { buildExport, exportFilename, type ExportMeta } from "./export.ts";
```

Add these module-level helpers near `wireHeader`:

```ts
const COPY_FLASH_MS = 1200;

/** Serialize the currently *filtered* view — exports match what the
 *  user sees, and the meta block records the filters that applied. */
function buildFilteredExportJson(state: PanelState, store: EventStore): string {
  const all = store.list();
  const events = all.filter((e) => matches(e, state.filters));
  const meta: ExportMeta = {
    exportedAt: new Date().toISOString(),
    url: window.location.href,
    userAgent: navigator.userAgent,
    capacity: store.capacity,
    droppedCount: store.dropped(),
    totalEvents: all.length,
    exportedEvents: events.length,
    filters: state.filters,
  };
  return buildExport(events, meta);
}

/** Swap a button's label for a moment (e.g. "Copied ✓"), disabling it
 *  so a double-click can't capture the flash text as the original. */
function flashButton(btn: HTMLButtonElement, label: string): void {
  const original = btn.textContent ?? "";
  btn.textContent = label;
  btn.disabled = true;
  window.setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, COPY_FLASH_MS);
}
```

- [ ] **Step 5: Wire the click handlers**

In `wireHeader`, after the `clearBtn` listener, add:

```ts
  ui.exportBtn.addEventListener("click", () => {
    const json = buildFilteredExportJson(state, store);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFilename(new Date());
    a.click();
    URL.revokeObjectURL(url);
  });
  ui.copyBtn.addEventListener("click", () => {
    const json = buildFilteredExportJson(state, store);
    navigator.clipboard.writeText(json).then(
      () => {
        flashButton(ui.copyBtn, "Copied ✓");
      },
      () => {
        flashButton(ui.copyBtn, "Copy failed");
      },
    );
  });
```

An empty filtered view is not special-cased: both actions produce a valid document with `events: []`.

- [ ] **Step 6: Typecheck and lint**

Run: `bun run --cwd packages/truapi-debug typecheck && bun run --cwd packages/truapi-debug lint`
Expected: both pass with no errors.

- [ ] **Step 7: Manual verification**

Run: `bun run preview:debug` from the repo root, open the served host URL, toggle the debug panel (Ctrl+Shift+D), let some events accumulate, then:

1. Click **Export** — a `dotli-debug-<timestamp>.json` file downloads; open it and confirm `meta` (url, counts, filters) and `events` are present and the JSON parses.
2. Set a filter (e.g. direction "out" or a tag query), export again — `exportedEvents` < `totalEvents` and `filters` reflects the UI.
3. Click **Copy** — button flashes "Copied ✓" and the clipboard holds the same JSON.
4. Confirm any event payload containing bytes shows full hex in the export (`__type: "Uint8Array"`, no trailing `…`).
