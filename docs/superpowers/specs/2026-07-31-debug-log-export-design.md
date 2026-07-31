# Debug panel: export & copy JSON for debugger logs

**Date:** 2026-07-31
**Package:** `packages/truapi-debug`
**Status:** Approved design, pending implementation

## Goal

Let devs get the dotli debugger's captured events out of the panel — as a
downloadable JSON file (for attaching to bug reports) and via
copy-to-clipboard (for quick sharing). Serves both the dotli team
triaging bug reports and product devs debugging their own dApps'
TrUAPI traffic.

## Scope

- Two new toolbar buttons in the debug panel, next to Pause/Clear, both
  icon-only (Lucide glyphs inlined in the panel's existing icon-button
  idiom) with hover tooltips:
  - **Export** (download icon, "Download as JSON") — downloads the
    currently *filtered* events as a JSON file.
  - **Copy** (clipboard icon, "Copy to clipboard") — puts the same JSON
    on the clipboard.
- Exports respect the active filter state (direction, product, tag
  query, TrUAPI/System visibility). The meta block records the filters
  and total-vs-exported counts so a partial export is self-describing.
- Full-fidelity payload serialization (no display truncation).

Out of scope: NDJSON output, exporting the unfiltered buffer alongside,
import/replay of exported files, tests (kept out of `truapi-debug` by
project convention).

## Design

### New module: `packages/truapi-debug/src/export.ts`

Pure, DOM-free serialization (same spirit as `format.ts`):

- `makeExportReplacer()` — full-fidelity variant of
  `format.ts`'s `makeReplacer()`:
  - `Uint8Array` → `{ __type: "Uint8Array", length, hex }` with the
    **complete** hex string (no 32-byte preview cap).
  - Strings untruncated.
  - `bigint` → `"123n"` string.
  - Cycles → `"[Circular]"` (WeakSet, per-call).
- `buildExport(events: readonly StoredEvent[], meta: ExportMeta): string`
  — returns pretty-printed (2-space) JSON. Wraps `JSON.stringify` in
  try/catch; on failure returns a valid JSON document with an `error`
  field in place of `events` so the export never produces a corrupt file.

### File shape

```json
{
  "meta": {
    "exportedAt": "2026-07-31T14:30:00.000Z",
    "url": "https://dot.li/...",
    "userAgent": "...",
    "capacity": 2000,
    "droppedCount": 0,
    "totalEvents": 1372,
    "exportedEvents": 240,
    "filters": {
      "direction": "outgoing",
      "product": "xyz",
      "tagQuery": "",
      "showTruapi": true,
      "showSystem": false
    }
  },
  "events": [ /* StoredEvent objects, fields as stored */ ]
}
```

- `events` are the `StoredEvent` objects as-is (seq, receivedAt,
  correlation keys, payloads) — no re-shaping, so the export mirrors
  what the store holds.
- `filters.product` follows the `FilterState` convention
  (`undefined` omitted = no filter, `null` = events without productId).

### Panel wiring (`panel.ts`)

- Filtered selection: `store.list().filter((e) => matches(e, filterState))`.
- **Export**: build JSON → `new Blob([json], { type: "application/json" })`
  → object URL → temporary `<a download>` click → revoke URL. Filename:
  `dotli-debug-<ISO timestamp with : and . replaced by ->.json`
  (e.g. `dotli-debug-2026-07-31T14-30-00.json`).
- **Copy**: `navigator.clipboard.writeText(json)`. On success, flash the
  button's icon to a checkmark for ~1.2 s; on rejection or a missing
  Clipboard API (permissions, non-secure context), flash an ✕ icon. No
  other error surface.
- Empty filtered view exports/copies a valid document with
  `events: []` — no special-casing, no disabled state.
- Buttons reuse the existing `td-btn` styling; a couple of CSS rules at
  most in `styles.css`.

## Error handling summary

| Failure | Behavior |
| --- | --- |
| `JSON.stringify` throws (exotic payload) | Valid JSON file with `error` field instead of `events` |
| Clipboard write rejected or API absent | ✕-icon flash on the button |
| No events after filtering | Valid export with `events: []` |

## Size estimate

~80 lines total (`export.ts` + panel wiring + CSS). No new dependencies.
