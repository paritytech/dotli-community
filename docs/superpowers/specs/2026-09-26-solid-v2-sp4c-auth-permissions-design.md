# Solid v2 migration: sub-project 4c (auth button, QR pairing modal, user popover, permissions popover)

Status: written by the controller under the owner's standing instructions of 2026-09-26 ("go with your recommendation for SP3 and SP4" and "continue, I'm still AFK").

Parents:
- `2026-09-26-solid-v2-sp4a-shell-prerender-design.md`: the static prerendered `Shell`.
- `2026-09-26-solid-v2-sp4b-shell-basics-design.md`: lazy islands. See its Amendment, decisions 14–18.

The code inventory was taken at commit 650a9df9. Its line references for `topbar.ts` are the ones used below.

## Goal

Four pieces of the static shell become lazy Solid islands, and their imperative code in `packages/ui/src/topbar.ts` is deleted:
- the auth button (`#auth-button`), with its logged-out icon, `.user-badge` and "Connecting..." states;
- the QR pairing modal (`#auth-modal-backdrop` and its children);
- the user popover (`#user-popover`);
- the permissions button, popover and backdrop (`#permissions-button`, `#permissions-popover`, `#permissions-popover-backdrop`), including the per-row permission dropdowns.

The `dotli:permission-changed` event detail is unified to `{ label, permission }`.

There is no visible change apart from the accessibility change in decision 6.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Islands | All four pieces follow the 4b pattern. `Shell.tsx` keeps their static markup unchanged, so the fidelity fixture does not change. Their components are added to `islands.tsx` `mountIslands()`, each mounted in isolation (`mountIsolated`). Static nodes are swapped by id. Components use native listeners only; the ESLint `on*` rule covers `components/shell/**`, so new components live there |
| 2 | Controllers stay eager and Solid-free | Events arrive before the islands chunk: `dotli:request-login`, auth-state changes, and the boot session rehydration from `SessionStore.emitPersistedSessionUiState`. The logic that must react to them moves out of `topbar.ts` into Solid-free modules. The islands only render store state, and read the current value on mount. The modules:<br>• `packages/ui/src/auth-controller.ts`: `initAuthController(coordinator)`, the login and disconnect requests, `openAuthModal` / `closeAuthModal`, and the blocking-modal lease (moved from `ensureAuthModalLease`, `openModal` and `closeModal`, unchanged).<br>• A store `packages/ui/src/state/auth-modal.ts`: `{ open, productLabel, reason, view }`, where `view` is `{ kind: "spinner" }`, `{ kind: "pairing", payload }`, `{ kind: "authenticating" }` or `{ kind: "error", message, retry }`.<br>The existing `state/auth.ts` `authStore` remains the source of auth state |
| 3 | QR rendering | `AuthModal.tsx` draws the QR on a canvas with a lazy `import("qrcode")`, as today. "Last payload wins": a render whose payload is no longer current, or whose view has changed or closed, is dropped. This is implemented with an effect-scoped token, not a module global. The mobile branch (deeplink first, a "Show QR instead" toggle, the get-app link) and the error view with retry are reproduced exactly. No QR refresh timer exists today, and none is added |
| 4 | The auth button before mount | The static `#auth-button` is `disabled` and `aria-busy` ("Connecting..."), and it stays that way until the island mounts. So there is nothing to replay, and `#auth-button` is not added to the early-click triggers. Today `initTopBar` enables it at boot; now it is enabled when the islands chunk arrives, which is fetched at boot. The landing page moves `#auth-button` into `#landing-auth`, and the swap replaces the node where it now is |
| 5 | Markup as JSX text | `.user-badge` (initials and the anonymous variant) and the modal title (`productLabel`) render as JSX text. This removes today's `escapeHtml` plus `innerHTML` template strings. The static per-permission SVG icons (`PERM_ICONS`) may use `innerHTML`, with the trusted-SVG lint disable |
| 6 | Accessibility | The user popover gains the same focus trap and Escape behaviour as the permissions popover (`createPopover` with `trapFocus`). This matches the owner's SP1 answer, "Consistent a11y". The permissions popover keeps its two-level Escape: an open row dropdown consumes Escape first, then the popover closes. The auth modal keeps its focus trap, and its `role="dialog"`, `aria-modal` and `aria-labelledby` |
| 7 | Permissions data | `PermissionsPopover.tsx` reads statuses through the existing async API in `packages/ui/src/permissions.ts`. It re-fetches when opened, and on `dotli:product-loaded`, `dotli:product-error`, `dotli:permission-changed` and `dotli:device-permission-changed`, using a render token so the last request wins. The permissions button's `.has-grants` class follows `hasAnyGrant`. The current product label moves into a Solid-free store, `state/product.ts`, if it is not already there, so a product that loads before the chunk is not missed |
| 8 | Event detail | `PermissionChange`'s `grant` variant requires `permission`, and `PromptPermission.ts` passes `permission: name`. `recordPermissionChange` always dispatches `{ label, permission }`. The only listener ignores the detail, so there is no behaviour change |
| 9 | Autohide and selectors | Ids, classes and the `.open` toggling stay the same. `topbar-autohide.ts` keeps working: `TOPBAR_SURFACE_IDS`, `OPEN_SURFACE_IDS`, and `isLoggedIn()` through `.user-badge`. The Playwright and e2e selectors also stay the same: `#auth-button`, `#auth-modal-backdrop.open`, `#auth-modal-title`, `#auth-modal-close`, `#auth-modal-qr canvas`, `#user-popover-username` and `#auth-button .user-badge` |
| 10 | What stays in `topbar.ts` | The mode, chains and settings popovers, the "more" flyout and the shared outside-click closer stay in `topbar.ts` until 4d. `trapPopoverFocus` also stays there, still used by the mode popover. The outside-click closer and the blocking-modal handler drop the user and permissions popovers, because the islands own them through `createPopover`. The "more" row that calls `#permissions-button.click()` keeps working after the swap, because it looks the button up by id at click time; verify this |
| 11 | Budget | Code moves from the startup path to the lazy chunk, and the controllers are roughly the size of the code they replace. Host startup must not grow compared with the end of 4b (96,631 B, plus 200 B of tolerance). The lazy chunk grows |
| 12 | Chunk failure | If the islands chunk fails to load, the auth button stays "Connecting..." and login is not possible. This is accepted, consistent with the 4b rulings. The failure is reported to Sentry, and a page that cannot fetch a chunk cannot pair either |

## Testing

- Unit tests for the controllers and stores: the lease queue and the stale-scope guard, login and disconnect event dispatch, and auth-state to modal-view mapping.
- Component tests for each island: markup parity with the old strings in `topbar.ts`, keyboard behaviour, outside click, Escape precedence, blocking-modal close, and product strings rendered as text.
- QR: last payload wins, including a late `qrcode` import after the view has changed.
- Swap tests: moved `#auth-button`, one element per id, and store state set before mount is rendered on mount.
- The existing `topbar.test.ts` auth and permissions blocks are rewritten against the components and controllers, with their behaviour assertions unchanged.
- `permissions.test.ts` is updated for the unified event shape.
- The functional suite passes unchanged. There are no Solid dev warnings.
- The e2e suite cannot run locally because the `truapi-host` CLI is missing. Its selectors are checked by reading them.

## Performance

- Host startup: no more than 96,831 B gzip.
- The running total must stay under the owner's +25 KB limit.
- Sandbox unchanged.
- Cold start: no regression beyond 5%.

## Done when

- The four pieces render from islands.
- Their imperative code is gone from `topbar.ts`, and `topbar.ts` no longer holds cached references to their nodes.
- The event detail is unified.
- All tests and gates pass, and the results are recorded in `docs/perf/solid-migration-baseline.md`.
