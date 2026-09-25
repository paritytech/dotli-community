# Solid v2 migration — sub-project 1: modals and toasts

Status: approved in brainstorming, 2026-09-25. Parent:
`2026-09-25-solid-v2-ui-migration-design.md` (umbrella). Builds on sub-project 0
(`2026-09-25-solid-v2-sp0-foundation-design.md`): Solid-free stores, `useStore`,
`mountRoot`, `ensureOverlayRoot`.

## Goal

Move the permission, preimage, password and confirmation dialogs and the toast
stack from hand-built DOM to Solid components rendered in one `overlays` root,
without growing either app's startup bundle and without changing any public
function, markup class, button label or promise result.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Loading | **Lazy overlays.** Public functions stay small, Solid-free and synchronous up to a store write. The Solid chunk is loaded with a dynamic import on first use and prefetched when the browser is idle after boot. Neither app's startup bundle includes Solid |
| 2 | Accessibility | **Consistent dialog accessibility** through one `Dialog` wrapper (role, ARIA, initial focus, focus trap, focus restore, Escape). Toasts gain a polite live region. No visual change |
| 3 | Host budget | Unchanged in sub-project 1. The known conflict (sub-project 4 puts Solid, about 15.5 KB gzip, on the host startup path, against the umbrella's +15 KB whole-migration limit) is decided in sub-project 4's spec with real measurements |
| 4 | Structure | Approach A: Solid-free `toasts` and `modals` stores, one lazily mounted overlays root with `<ToastStack>` and `<ModalOutlet>`, one generic `SigningDialog` renderer |

Measured input for decision 1: a minimal Solid 2 RC bundle (`render`, signals,
`For`, `Show`; esbuild, production conditions, minified) is 39,761 B raw /
15,543 B gzip.

## Scope

In:

- `packages/ui/src/permission-modal.ts` (`showPermissionRequestModal`)
- `packages/ui/src/preimage-modal.ts` (`showPreimageSubmitModal`)
- `packages/ui/src/password-prompt.ts` (`showPasswordPrompt`)
- `packages/ui/src/host-callbacks/UserConfirmation.ts` (the confirmation dialog
  inside `createUserConfirmationAdapters`)
- `packages/ui/src/notification.ts` (`showNotification`, the toast stack)
- Deleting `packages/ui/src/components/dev/SolidProbe.tsx` and its test

Out:

- The topbar auth / QR modal (sub-project 4).
- `blocking-modal-queue.ts`, `PromptPermission.ts`, `PushNotification.ts`,
  `scheduled-notifications.ts`: unchanged.
- CSS: unchanged (`signing.css`, `password-prompt.css`, `toasts.css`, and the
  `.permission-modal-*` rules in `topbar.css` / `themes.css`).
- Unifying button copy between the permission and confirmation dialogs.

## Architecture

### Files

Solid-free (may be imported by app startup code):

| File | Role |
|---|---|
| `state/toasts.ts` | `toastsStore: ReadableStore<ToastEntry[]>`; `pushToast`, `dismissToast`, `removeToast`, `dismissAllToasts`, `setToastsExpanded`; auto-dismiss timers |
| `state/modals.ts` | `modalsStore: ReadableStore<ModalEntry[]>`; `openModal`, `settleModal`, `failAllModals` |
| `overlays/load.ts` | `ensureOverlays`, `prefetchOverlays`, the load-failure fallback |
| `notification.ts` | unchanged exports; validation and the browser Notification API; calls `pushToast` and `ensureOverlays` |
| `permission-modal.ts`, `preimage-modal.ts`, `password-prompt.ts` | unchanged exports and signatures; build a `ModalView` and call `openModal` |
| `host-callbacks/UserConfirmation.ts` | unchanged exports; confirmation copy and fields stay here; the internal `showConfirmationModal` builds a `ModalView` and calls `openModal` |

Solid (only reachable through the dynamic import in `overlays/load.ts`):

| File | Role |
|---|---|
| `components/overlays/mount.tsx` | chunk entry: `mountOverlays()` mounts `<ToastStack/>` and `<ModalOutlet/>` into `ensureOverlayRoot()` via `mountRoot("overlays", …, { onError })` |
| `components/overlays/ToastStack.tsx`, `ToastCard.tsx` | toast stack |
| `components/overlays/ModalOutlet.tsx` | renders the first entry of `modalsStore` |
| `components/overlays/Dialog.tsx` | accessibility wrapper |
| `components/overlays/SigningDialog.tsx` | renders a `ModalView` |

`mount/root.ts`: `mountRoot(name, container, view, options?)` gains an optional
`options.onError(err)` called after the existing once-per-error Sentry report.

App changes: `apps/host/src/main.ts` and `apps/sandbox/src/main.ts` each call
`prefetchOverlays()` once after boot. No app imports anything under
`components/`.

### Modal data model

```ts
type ModalButtonVariant = "cancel" | "secondary" | "primary";

interface ModalView<R> {
  title: string;
  icon?: string; // SVG markup, rendered in .permission-modal-icon
  fields: { label: string; value: string; mono?: boolean; warning?: boolean }[];
  notice?: string; // .permission-modal-notice
  input?: { kind: "password"; placeholder: string; hint?: string; error?: string };
  buttons: { label: string; variant: ModalButtonVariant; result: R }[];
  dismissOnBackdrop: boolean;
  dismissResult?: R; // required when dismissOnBackdrop is true
  fallbackResult: R; // used when the overlays cannot render
}

function openModal<R>(view: ModalView<R>, signal?: AbortSignal): Promise<ModalOutcome<R>>;
type ModalOutcome<R> = { result: R; value?: string }; // value = password input
```

Button order in `buttons` is display order. Each wrapper maps the outcome to
its existing return value or error, so every public promise resolves and
rejects exactly as today:

| API | Outcomes |
|---|---|
| `showPermissionRequestModal` | `granted` / `granted-once` / `denied` / `dismissed` (backdrop, Escape); fallback `dismissed` |
| `showPreimageSubmitModal` | resolves on Allow; rejects `ERRORS.PREIMAGE_SUBMIT_DENIED` on Cancel; no backdrop dismissal; fallback = Cancel |
| `showPasswordPrompt` | resolves with the password on Unlock or Enter (non-empty only); rejects `ERRORS.DECRYPTION_CANCELLED` on Cancel; no backdrop dismissal; fallback = Cancel |
| confirmation (`confirmUserAction`, `confirmPermission`) | `accepted` / `accepted-once` / `rejected` / `dismissed`; a dismissed `IdentityDisclosure` still throws `ERRORS.IDENTITY_DISCLOSURE_DISMISSED`; fallback `dismissed` |
| all, on abort | an already-aborted signal rejects with `blockingModalAbortError(signal.reason)` before any store write or chunk load; a later abort removes the entry and rejects the same way |

Every entry settles exactly once (button, dismissal, abort, fallback or
`failAllModals`, whichever comes first).

### Dialog rendering and accessibility

`SigningDialog` emits today's markup: `.signing-modal-backdrop >
.signing-modal`, optional `.permission-modal-icon`, `h2`, `.signing-fields` with
`.signing-field` (`.signing-field-warning` when `warning`), `.signing-field-label`,
`.signing-field-value` (`.mono`), optional `.permission-modal-notice`, optional
password hint, `.password-prompt-error` and `input.password-prompt-input`
(`type="password"`, `autocomplete="off"`, `spellcheck="false"`), and
`.signing-modal-footer` with `button.signing-btn-cancel` /
`.signing-btn-secondary` / `.signing-btn-sign` by variant. Labels are the
current ones ("Deny", "Allow", "Always allow", "Allow once", "Sign",
"Cancel", "Unlock", and the per-review copy from `UserConfirmation.ts`); the
e2e helpers click by these names.

`Dialog` adds:

- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` on the title.
- Initial focus: the password input when present, otherwise the dialog
  container (`tabindex="-1"`). Never the primary button, so a stray Enter
  cannot approve a signature or permission.
- Tab / Shift+Tab cycle within the dialog.
- On close, focus returns to the element focused before opening, if it is
  still in the document.
- Escape does what a backdrop click does: dismisses when
  `dismissOnBackdrop`, otherwise nothing.
- Password: "Unlock" is disabled while the input is empty; Enter submits only
  when non-empty.

`ModalOutlet` renders only the first entry; later entries wait. Blocking host
dialogs are still serialized one level up by `blocking-modal-queue.ts`.

### Toasts

`showNotification(params: NotificationParams): void`, `NotificationParams` and
`NOTIFICATION_DISMISS_MS` are unchanged. `notification.ts` keeps, outside
Solid: trimming text to 200 characters and ignoring empty text, dropping
non-`http(s)` deeplinks, and the browser Notification API path (tab hidden
only, permission handling, native notification closed after 5 s). Then it calls
`pushToast` and `ensureOverlays()`.

`state/toasts.ts` holds `ToastEntry { id, text, label, deeplink?, icon,
iconBackground?, action?, onDismiss?, leaving }`, newest last, and the
auto-dismiss timers with today's rules: default 10 s, `dismissMs: 0` persistent,
paused while expanded or while the tab is hidden, resumed from the remaining
time. `dismissToast(id)` calls `onDismiss` at the same point as today and marks
the entry `leaving`; `removeToast(id)` deletes it; `dismissAllToasts()` pauses
every timer and marks all entries leaving.

`ToastStack` / `ToastCard` emit today's markup: `.notif-stack > .notif-cards`
and `button.notif-close-all` (`aria-label="Dismiss all"`, hidden and `.single`
unless more than one toast), cards `.notif-card[data-id]` with `.notif-icon`
(optional inline background), `.notif-text`, `.notif-title`, `a.notif-body`
(`target="_blank"`, `rel="noopener"`) or `span.notif-body`, optional
`button.notif-action`, and `button.notif-card-close` (`aria-label="Dismiss"`).
Behaviour:

- Collapsed: the newest 3 cards are visible with the `--i` depth variable;
  older ones get `.notif-hidden-card`.
- Clicking the card area while collapsed with more than one toast (not on a
  link) expands; an outside click (capture phase) or window blur collapses.
  These listeners exist only while expanded.
- `.notif-enter` is removed on `animationend`. A leaving card gets
  `.notif-leave` and calls `removeToast` on `animationend`; a hidden card is
  removed immediately.
- With no entries, `.notif-stack` is not rendered.
- New: `.notif-cards` has `role="status"` and `aria-live="polite"`.

### Loading and failure handling

- `ensureOverlays()` memoizes `import("../components/overlays/mount")` and calls
  `mountOverlays()` once. Store writes before the mount are rendered once it
  mounts.
- `prefetchOverlays()` calls `ensureOverlays()` from `requestIdleCallback`, or
  `setTimeout(…, 2000)` where unavailable.
- Import failure: `captureException(err, { kind: "overlays_load_error" })`;
  pending toasts with an `action` fall back to
  `window.confirm(label + "\n\n" + text)` and run `action.onClick` on OK; other
  pending toasts are dropped without calling `onDismiss`; pending modals settle
  with their `fallbackResult`. The memo is cleared so the next call retries.
- Render error inside the root: `mountRoot`'s `onError` calls `failAllModals()`
  (every open entry settles with its `fallbackResult`) and clears the toasts.

## Testing

- Unit (Vitest, happy-dom): `state/toasts` (fake timers, pause and resume on
  visibility and expanded, `onDismiss` order, dismiss-all), `state/modals`
  (settle once, abort before and after, FIFO order, `fallbackResult`,
  `failAllModals`), `overlays/load` (single import, failure fallback,
  retry).
- Components (`@solidjs/testing-library`): `ToastStack` (3 visible, hidden
  cards, close-all visibility, expand and collapse, removal on `animationend`),
  `SigningDialog` / `Dialog` (markup and labels, ARIA, initial focus, focus trap,
  focus restore, Escape vs backdrop per view, password Enter and disabled
  Unlock).
- Existing tests keep exercising the public functions:
  `permission-modal.test.ts` (7), `user-confirmation.test.ts` (23),
  `notification.test.ts` (4). They wait for the lazy mount through a test
  helper. New: `password-prompt.test.ts`, `preimage-modal.test.ts`.
- Playwright: the functional suite, including the toast smoke test, must pass.
  The umbrella requires the `truapi` e2e suite before this sub-project is done;
  it needs a local product app, and if that is unavailable here the run is left
  to the owner and recorded.

## Performance gates

| Metric | Gate |
|---|---|
| Host startup bundle (entry + modulepreloaded chunks, gzip, `scripts/eager-path-size.ts`) | at most +2 KB net versus the branch before sub-project 1 |
| Sandbox startup bundle | at most +2 KB net |
| Solid in startup chunks | none (checked through sourcemap `sources`) |
| Overlays chunk | size recorded |
| Cold start (`Host total`, 20 runs, A/B against the branch before sub-project 1) | no regression beyond 5% |

Results go into an "After sub-project 1" section of
`docs/perf/solid-migration-baseline.md`.

## Done when

- The five in-scope modules render through the overlays root; their old DOM
  code is gone; `SolidProbe` is deleted.
- Public signatures, promise results and errors, markup classes and button
  labels are unchanged (the existing tests pass through public functions).
- New unit and component tests pass; typecheck, lint, format and the
  functional suite pass.
- The gates above pass and are recorded.
- Owner's manual pass: a toast, a permission prompt, a signing prompt and the
  password prompt, including keyboard use.
