# Radix-style popover, menu and dialog focus: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each shell surface's focus and keyboard behaviour should match the Radix primitive it corresponds to: Popover, DropdownMenu or Dialog.

**Architecture:** `createPopover` in `packages/ui/src/components/shell/popover.ts` gets a `mode` option, and each island switches to its mode.

**Tech Stack:** Solid 2 RC, Vitest, Playwright (Task 4 only).

**Spec:** `docs/superpowers/specs/2026-09-27-solid-v2-radix-focus-design.md`.

## Global Constraints

- Branch `feat/solid-v2-foundation`, local only. Never push.
- Keep ids, classes, copy and the `.open` toggling unchanged. Change ARIA only where Radix differs, and list every ARIA change in the task report.
- Components use native listeners only, enforced by the ESLint `on*` rule. Keep callback refs, `untrack` for one-time reads, `eqeqeq`, and `flush()` only from event, rAF or timer callbacks. There must be no Solid dev warnings; check with `cd packages/ui && NODE_OPTIONS=--no-experimental-webstorage bunx vitest run --reporter=default --silent=false`.
- Every commit passes `bun run typecheck`, `bun run lint` and `bun run test`, plus `bunx prettier --check` on changed files.
- Tasks 1–3 run no size builds, Playwright or cold start. That is the owner's instruction; only Task 4 does.

## Review Focus

1. **Popover focus leaving.** A `popover` closes when focus leaves it. Focus moving between the trigger and the surface must not close it, and neither may a click inside it that briefly blurs. Pinned in Task 1.
2. **Menu outside click.** A `menu` outside click must not activate what lies under it. Pinned in Task 1.
3. **Nested Escape.** When a popover holds an open row dropdown, Escape closes the dropdown first. Pinned in Task 2.
4. **Auth modal lease.** The auth modal must not close on its own blocking-modal lease, while other surfaces still close when a blocking modal opens. Pinned in Task 3.
5. **More-flyout hand-off.** Opening settings or theme from the "more" flyout moves focus into the opened surface, and closing it returns focus to `#more-button` when the trigger is hidden. Pinned in Task 3.

---

### Task 1: Modes in the popover primitive

**Files:** modify `packages/ui/src/components/shell/popover.ts` and `packages/ui/tests/components/shell/popover.test.tsx`.

Add `mode: "popover" | "menu" | "dialog"`, required, and remove `trapFocus`. Keep `closeOnBlur`, `shouldHandleEscape`, `onClose` and the blocking-modal close. Also add `closeOnBlockingModal?: boolean`, default true, which the auth modal will set to false.

Implement spec decision 1 for each mode:

**All modes**
- Initial focus goes to the first tabbable element in the surface, or to the surface itself.

**`popover`**
- Focus leaving closes it. Use `focusout` with `relatedTarget` outside both the trigger and the surface, and ignore a null `relatedTarget` caused by a window blur unless `closeOnBlur` is set.
- An outside pointerdown closes it without returning focus.

**`menu`**
- Roving focus over `[role^="menuitem"]`: ArrowUp and ArrowDown loop, Home and End jump, and typeahead matches the first letter of the item text.
- Tab is prevented.
- An outside pointerdown closes it and swallows the following click (capture phase, once).
- Opening from the keyboard (Enter, Space or ArrowDown on the trigger) focuses the first item. Opening with a pointer focuses the content.
- Expose `onItemChosen()`, which closes the menu and returns focus to the trigger.

**`dialog`**
- Focus is trapped, reusing `containTab`.
- Page scroll is locked (`document.body.style.overflow = "hidden"`, restored on close).

Also export small ARIA helpers for triggers and surfaces, or document the attributes each mode expects.

**Tests:** cover every behaviour listed above, one describe block per mode.

- [ ] Tests first; implement; checks; commit `feat(ui): give the shell popover primitive Radix-style modes`.

### Task 2: Popover-mode surfaces

**Files:**
- `UserPopover.tsx`, `PermissionsPopover.tsx`, `ChainsPopover.tsx`, `VerificationShield.tsx`, and `SettingsPopover.tsx` (desktop only) in `packages/ui/src/components/shell/`, with their tests.
- `AuthButton.tsx` if the user-popover trigger's ARIA lives there.

Switch each surface to `mode: "popover"`, and set the ARIA from spec decision 3: `role="dialog"` on the surface, and `aria-haspopup="dialog"`, `aria-expanded` and `aria-controls` on the trigger. The permissions popover keeps `shouldHandleEscape` for its row dropdowns.

**Tests:** one per island, checking:
- the ARIA attributes;
- focus goes into the surface on open;
- Tab past the last element closes the surface and focus moves on;
- an outside click closes it without returning focus;
- Escape returns focus.

Also test that in the permissions popover an open row dropdown consumes Escape first.

- [ ] Tests first; implement; checks; commit `feat(ui): make shell popovers non-modal like Radix Popover`.

### Task 3: Menu and dialog surfaces

**Files:**
- `ThemeToggle.tsx` and `MoreMenu.tsx` become `menu`.
- `AuthModal.tsx` becomes `dialog` on the primitive with `closeOnBlockingModal: false`. Delete its local trap and the focus helpers exported only for it, if they are now unused.
- `SettingsPopover.tsx` uses `dialog` on the mobile sheet. Choose the mode by the same breakpoint the CSS uses (560px, `matchMedia`) at the moment the popover opens.
- Tests for each.

**Behaviour:**
- **Theme:** the existing arrow and Home/End handling moves into the primitive; delete the local copy. Choosing an option calls `onItemChosen`.
- **More:** its rows become `role="menuitem"`. Choosing one closes the flyout, returns focus, then forwards the click to the target. The target surface then takes focus as its own mode dictates.

**Tests:**
- Menu typeahead.
- Tab is prevented.
- An outside click is swallowed.
- An item choice returns focus.
- The auth modal traps focus, locks scroll, and survives its own lease.
- The mobile settings sheet traps focus. The desktop settings popover does not.
- The "more" hand-off from Review Focus 5.

- [ ] Tests first; implement; checks; commit `feat(ui): make shell menus and dialogs behave like Radix`.

### Task 4: Verify

- [ ] Build (`VITE_NETWORKS=paseo-next-v2,previewnet bun run build`), then run `bun run test:functional` in `apps/host` in the background. Free port 5173 and kill any stale preview server first. All specs must pass, including `ui-smoke` and `host-settings`. Read the e2e selectors to confirm they still match.
- [ ] Measure host startup: `bun scripts/eager-path-size.ts apps/host/dist`. It must stay under the raised limit of +35 KB over 74,649 B (110,489 B). Report the change against d92315f3.
- [ ] Record a short "After the Radix focus work" note in `docs/perf/solid-migration-baseline.md`, and commit `docs(perf): record the Radix focus change`. The perf doc has an uncommitted table re-alignment that is not ours. `git add -p` is interactive, so do this instead:
  1. Save the stray diff to a patch in the scratchpad.
  2. `git checkout` the file.
  3. Add your note and commit it.
  4. `git apply` the patch again, leaving it uncommitted.

  Skip the cold-start A/B, because this change has no effect on startup work.
