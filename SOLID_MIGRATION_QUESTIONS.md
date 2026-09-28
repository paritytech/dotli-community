# Solid v2 migration — open questions and doubts

Collected while executing sub-project 0 (Foundation) unattended on branch
`feat/solid-v2-foundation`. Nothing has been pushed or merged. This file is
untracked on purpose; delete it when done.

Each item: the question or doubt, what I decided in the meantime, and what it
costs if the decision is wrong.

## Your answers (2026-09-25 review)

All questions are answered. The fix plan is
`docs/superpowers/plans/2026-09-25-solid-v2-sp0-review-fixes.md` (`5a1dff4b`).

| #   | Question                                              | Answer                                        | Action                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | PR shape (item 3)                                     | One PR with specs, plans and code             | No branch split; open one PR once you give the go-ahead — pending your go-ahead                                                                                                                                                                                                        |
| Q2  | Manual UI check (item 8)                              | Automate it too                               | Add a Playwright UI smoke spec for the checklist; you do a short manual pass — done, `ffe6f9dc`                                                                                                                                                                                        |
| Q3  | Spec corrections after approval (item 2)              | Keep all                                      | None — done                                                                                                                                                                                                                                                                            |
| Q4  | Alias modal and its error strings (item 7)            | Keep the modal deleted, deprecate the strings | Add `@deprecated` JSDoc to `ALIAS_PERMISSION_DENIED` / `ALIAS_PERMISSION_DISMISSED`. The modal has had no caller since "Switch to Rust core" (#70), which removed its only call site in `container.ts`; if alias consent comes back it becomes a Solid modal — done, `a2471087`        |
| Q5  | Two `dotli:permission-changed` detail shapes (item 6) | Unify in SP4                                  | Note it in the umbrella spec's SP4 row — done, `41180839`                                                                                                                                                                                                                              |
| Q6  | CI only checks `index-*.js` (item 10, follow-up)      | Measure the eager path in CI                  | Script to sum entry + modulepreload chunks; warn-only budgets for host and sandbox in `bundle-size.yml` — done, `f7ac2dd6`                                                                                                                                                             |
| Q7  | Cold start is provisional (item 9, follow-up)         | `PERF_RUNS=20` A/B, main vs branch            | Run both back to back, record both medians in the baseline doc — done, `4bfda152` (main p50 2492 ms vs branch p50 2530 ms, +1.5%, not significant; pass)                                                                                                                               |
| Q8  | Gitignore perf results (item 5)                       | Leave it                                      | None — done                                                                                                                                                                                                                                                                            |
| Q9  | R14: runtime-narrow store exports                     | Keep type-only                                | None — done                                                                                                                                                                                                                                                                            |
| Q10 | R13: `ownedWrite: true` in `useStore`                 | Keep                                          | None — done                                                                                                                                                                                                                                                                            |
| Q11 | RC bump policy (item 1)                               | Keep policy                                   | None — done                                                                                                                                                                                                                                                                            |
| Q12 | Nits (follow-ups)                                     | Fix both                                      | Relative `./network-monitor` import in `topbar.ts`; rename `setChainsButtonVisibleState` → `recordChainsButtonVisible` (not `setChainsButtonVisible`: `topbar.ts` already exports a DOM function with that name, which calls this setter) — done, import `8934fe40`, rename `91755caa` |

## Decisions needed from you before merge

1. ~~**Size budget (item 9).**~~ **Resolved:** you chose option (b). Stores are
   now Solid-free; host eager path +2,138 B gzip and sandbox +129 B versus
   pre-migration, both under the 3 KB gate. No Solid package ships in any app
   bundle yet.
2. ~~**Manual UI check (item 8).**~~ **Answered (Q2):** automated smoke spec plus a short manual pass.
3. ~~**PR shape (item 3).**~~ **Answered (Q1):** one PR.

Everything else below is lower priority.

## Before execution

1. **Solid 2 is still RC (`2.0.0-rc.9`).** You chose to ship on the RC with
   exact pins. Doubt: the whole migration (6 sub-projects) will likely span
   several RC bumps; each may change APIs. Decided: pins + `chore:` bump PRs +
   `solid-migration-assistant` on each bump (in the baseline doc checklist).
2. **Spec corrections after you approved it** (committed in `4e7d534`):
   `jsxImportSource` is `@solidjs/web`, not `solid-js`; product store carries
   `productId`; permissions store is a change counter, not a full status map;
   network store is started explicitly (not lazily). Please confirm these are
   fine.
3. **Branch/worktree.** Work runs on `feat/solid-v2-foundation` in the main
   checkout (not a separate git worktree), branched from
   `docs/solid-v2-migration-spec`. The spec/plan commits are therefore part of
   this branch. Question: do you want specs/plan in the same PR as the code, or
   split into a docs PR first?
4. **Size gates are estimates** (+15 KB gzip over whole migration, <3 KB for
   sub-project 0). They get checked against real numbers at the end of this
   run; if they are unrealistic you may want to change them.

## During execution

(appended as tasks run)

5. **Perf results folder isn't gitignored.** `bun run --cwd apps/host test:perf:base`
   writes `apps/host/tests/performance/results/`, which is neither committed
   nor gitignored. I left it untracked. Question: should it be added to
   `.gitignore`? (Pre-existing, not changed by this branch.)
6. **An extra permission-event producer was found in `topbar.ts`** (the
   permissions-popover dropdown), which the plan didn't list. I had it routed
   through the permissions store too. Its first version dropped the
   `permission` key from `dotli:permission-changed`; review caught it and it
   was fixed (`9fedec2`), so both event shapes are now exactly as before.
   Note that the two producers already sent _different_ detail shapes before
   this branch (`{ label }` from PromptPermission vs `{ label, permission }`
   from the topbar). Question: should that be unified in a later sub-project?
7. **Orphaned error strings after deleting the alias modal.**
   `ERRORS.ALIAS_PERMISSION_DENIED` and `ERRORS.ALIAS_PERMISSION_DISMISSED` in
   `packages/ui/src/errors.ts` are now unreferenced. The file says these
   strings are a pinned external contract that products may branch on, so I
   did **not** remove them. Question: remove them (and check product repos),
   or keep them?
8. **Manual check still needed from you.** An unattended agent can't click
   through the UI. Task 12 ran the functional Playwright suite (35 passed,
   2 skipped) and a `bun preview` smoke (HTTP 200) instead. Please do the
   plan's manual check once: landing + recent pills, opening a `.dot` name,
   login QR modal open/close, theme toggle, offline banner, a toast.
9. **The size gate failed: +9.8 KB gzip on the host's eager path (gate was
   <3 KB).** Most of it is Solid's reactive core (`@solidjs/signals`, about
   9 KB gzip), which the stores pull in because they're imported by
   code that runs at startup (bridge, topbar, host callbacks). My <3 KB
   estimate was wrong. I accepted it for sub-project 0, since the hydrated
   shell in sub-project 4 needs the reactive core at startup anyway. But it
   has consequences you should decide on:
   - The whole-migration budget of +15 KB gzip is now at risk: the reactive
     core alone uses ~9 KB, and `@solidjs/web` (the DOM runtime) still has to
     land in sub-projects 1–4.
   - Options: (a) raise the budget (e.g. +25 KB) and accept it;
     (b) keep stores Solid-free (a tiny subscribe/notify) until a component
     actually needs a signal, deferring the ~9 KB to sub-project 1;
     (c) lazy-load the reactive layer. My recommendation is (b); see its
     concrete shape below.
   - **The sandbox is hit too, and harder relative to its budget:** sandbox
     `index.js` +9,462 B gzip, about 95% of its +10 KB whole-migration budget.
     Cause: `ui.ts` (used by the sandbox's error screen) now imports the
     product store, which pulls in the reactive core. The final reviewer
     caught this; it's now recorded in the baseline doc.
   - **Concrete shape of option (b), the one the final reviewer recommends:**
     `createSyncStore` becomes plain `{ get, set, subscribe, reset }` with no
     Solid import; a small UI-only helper (e.g. `components/use-store.ts`)
     turns `subscribe` into a Solid signal for components. The stores'
     exported reactive accessors (`authState`, `productState`, …) move to
     that helper. This takes ~9 KB gzip off **both** eager paths now and
     defers Solid to sub-project 1, where a component first needs it. Cost:
     one task (create-store + 8 store modules' exports + their tests), and a
     small change to the approved store interface. I did **not** apply it
     unattended because it changes the design you approved. Say the word
     and it's one follow-up task.
   - **Merge is blocked on this decision:** the spec's "Done when" requires the
     size numbers within the gates. Either amend the gates (SP0 and the
     umbrella's +15 KB host / +10 KB sandbox) or take option (b).
   - Cold start did **not** regress: the median went 2787 → 2532 ms (−9%),
     probably partly noise (10 vs 20 runs). A `PERF_RUNS=20` re-run would
     confirm.
10. **The bundler moved existing code into a new chunk.** Adding the stores
    caused the bundler to split out a new host chunk
    (`scheduled-notifications-*.js`), mostly pre-existing code relocated from
    `index-*.js`. Harmless, but the per-file size comparison in the
    bundle-size CI comment will look odd (index shrinks by ~21 KB, a new chunk
    appears).

## Rulings I made (from the execution ledger, in order)

- Ruling R1: Task 1 Step 1 skipped; the controller created feat/solid-v2-foundation in the main checkout (not a separate worktree) — the branch is off main so isolation holds and subagents share one path — cost if wrong: none beyond a less-isolated checkout.
- Ruling R2: Baseline is measured on feat/solid-v2-foundation HEAD (4e7d534, docs-only over main d8f0167) — code is identical to main — cost if wrong: none.
- Ruling R3: Tasks 5 and 6 (product, permissions stores) batched into one implementer dispatch with one commit each and one combined review — same shape, disjoint files — cost if wrong: a single review covers two tasks, slightly less focused.
- Ruling R4: Tasks 5+6 review "Important: topbar.ts routing is scope creep" — the controller's dispatch explicitly instructed routing any extra producer found, so routing stays — cost if wrong: one extra producer moved earlier than planned (it would move in sub-project 4 anyway).
- Ruling R5: Tasks 5+6 review "Critical: topbar grant dispatch drops `permission` from dotli:permission-changed detail" — real violation of the exact-detail-shape constraint; fix by adding optional `permission` to the grant variant and including it in detail only when provided (PromptPermission keeps `{ label }`, topbar keeps `{ label, permission }`) — cost if wrong: none; restores the old shapes exactly.
- Ruling R6: Tasks 8 and 9 (topbar+theme, network+settings stores) batched into one dispatch, one commit per task, one combined review — same shape as 5+6 — cost if wrong: slightly less focused review.
- Ruling R7: Task 11 (delete unused alias modal, 1 file, no tests) folded into the Task 10 dispatch as a separate commit, reviewed together — trivial deletion with a grep gate — cost if wrong: negligible.
- Ruling R8: Task 12 Step 5 (manual click-through in a browser) cannot be done by an unattended agent; replaced by the functional Playwright suite plus a `bun preview` smoke (server starts, host page and landing return 200) and left as a to-do for the user in the questions file — cost if wrong: a visual regression not covered by Playwright could slip to the user's check.
- Ruling R9: Cold-start gate — the umbrella spec's "no regression beyond 5%" governs over the plan's "within 5%" paraphrase; a 9% speed-up passes (flagged as likely noise at 10 vs 20 runs) — cost if wrong: none, no regression exists.
- Ruling R10: Host eager size gate FAILS (+9,833 B gzip vs <3 KB). Not fixed in SP0: most of it is @solidjs/signals (~29% of a 30.8 KB-gzip chunk ≈ 9 KB gzip), which the stores need and which sub-project 4's hydrated shell needs on the eager path anyway; the <3 KB estimate was wrong. Surfaced to the user as a budget question (umbrella +15 KB total is at risk once @solidjs/web lands) — cost if wrong: ~10 KB gzip on the cold-start path ships before the UI benefits; could be revisited by lazy-creating signals or keeping stores Solid-free until SP1.
- Ruling R11: The Solid-free store redesign (move Solid out of createSyncStore; components adapt via a subscribe→signal helper) is NOT applied in the final fix wave — it changes the approved store interface (every state module's reactive accessor and the store tests), and the budget trade-off is the owner's call; instead both numbers and a concrete design are put in the questions file — cost if wrong: owner must request the redesign in a follow-up (est. one task: create-store + 8 store modules' exports + their tests).
- Ruling R12: Final fix wave covers: sandbox number into the baseline doc; topbar.ts import-style consistency (relative ./state/*); mountRoot one-shot Sentry report per error. Deferred as follow-ups (questions file): PERF_RUNS=20 re-run, CI eager-budget coverage, setChainsButtonVisibleState naming — cost if wrong: minor.

- Ruling R13: `useStore`'s mirror signal uses `{ ownedWrite: true }` — the store is the source of truth and the signal only mirrors it, so a store write from inside a Solid scope (component body, `createRoot`, memo) is legitimate; the alternative (banning setters in owned scopes) burdens non-UI callers who can't know their scope — cost if wrong: loses Solid's dev-mode write guard for this one mirror signal.
- Ruling R14: The addendum's final fix wave also made `useStore` throw outside an owner, documented that store notifications are synchronous and listeners must not call setters, switched the parent spec's size gates to the whole eager path, marked the old "accepted" ruling superseded, and marked the cold-start pass provisional. Not taken: narrowing store exports at runtime to `{ get, subscribe }` (type-level narrowing only) — cost if wrong: a deliberate cast could call `set` and skip the window event.

Rulings from the review-fixes plan (`docs/superpowers/plans/2026-09-25-solid-v2-sp0-review-fixes.md`):

- Ruling R15: the plan was committed on the branch (5a1dff4b) before Task 1, since you chose one PR with specs and plans — cost if wrong: one docs commit to drop.
- Ruling R16: the eager-path script measures gzip with the `gzip -c <file>` CLI, not Node/Bun zlib. zlib came out +196 B (host) / +952 B (sandbox) over the CLI numbers the baseline and budgets were built from; the file-path form reproduces the baseline tables exactly on macOS. CI's GNU gzip may differ by a few bytes to a few hundred (documented) — cost if wrong: needs `gzip` on PATH (present on ubuntu-latest and macOS; the script exits 1 with a message otherwise).
- Ruling R17: the store setter is `recordChainsButtonVisible`, not `setChainsButtonVisible` (name already taken by the DOM function in `topbar.ts`) — cost if wrong: a rename.
- Ruling R18: the final review covered this plan's commits only (14e54702..HEAD); the earlier SP0 commits had their own final review — cost if wrong: an interaction with older SP0 code could be missed.
- Ruling R19: the smoke spec uses `PORT` while the reset fixture uses `COMBO_PORT` (existing pattern, both default 5173); left as is — cost if wrong: overriding only one of them makes seed and reset hit different servers.

## Follow-ups (not blocking)

None. The four follow-ups above (`PERF_RUNS=20` re-run, CI eager-path budget, the `topbar.ts` import style, and the `setChainsButtonVisibleState` name) were all closed by the review-fixes plan; see the "Your answers" table for the commit hashes.

## Branch state

`feat/solid-v2-foundation`, 34 commits over `main`, local only (not pushed, no PR). Specs and plan are included on the branch.

---

# Sub-project 1 (modals and toasts) — run while you were AFK

Spec `docs/superpowers/specs/2026-09-25-solid-v2-sp1-overlays-design.md` and plan
`docs/superpowers/plans/2026-09-25-solid-v2-sp1-overlays.md` were approved by you
before you left. Execution continues subagent-driven; nothing is pushed.

## Rulings made during execution

- SP1-R1: Lint rules the plan did not anticipate: element refs use the callback form (`ref={(el) => { x = el; }}`, ESLint `no-unassigned-vars`), and trusted SVG keeps `innerHTML` with `eslint-disable-next-line solid/no-innerhtml` (host-authored SVG, same trust as today). Cost if wrong: a mechanical switch to ref-callback `innerHTML`.
- SP1-R2: Task 5's loader tests were strengthened beyond the plan's text (a DOM assertion instead of a store-only one; the module-replacing failure test runs last). Cost if wrong: none.

- SP1-R3: The e2e step was skipped (the `truapi-host` CLI isn't installed, and `test:e2e:local` would symlink a local truapi into `node_modules`). Cost if wrong: an e2e regression in the signing dialogs surfaces only when you run it.
- SP1-R4: The final review covered SP1's commits only (31c67a34..HEAD). Cost if wrong: an interaction with SP0 code could be missed.
- SP1-R5: The final review found that after a render error the overlays root stayed dead and later dialogs hung. Fixed (8b997e26): the loader now remounts, and dialogs that still can't render settle with their fallback result. Escape now stops propagation, so it no longer also closes a popover underneath.
- SP1-R6: Not fixed: toasts can paint under `z-index: 900` elements appended to `body` after `#overlay-root` was created (e.g. the sandbox-checker dev panel). Re-appending the root on each toast would blur a focused dialog input. Question: acceptable, or should the overlay root get a higher z-index in CSS (a styling change, out of scope so far)?

## Questions and doubts

(appended as tasks run)
- SP1: e2e (`truapi` suite) was NOT run: `../host-playground` exists but the `truapi-host` signing CLI the e2e global setup needs is not installed, and the root `test:e2e:local` script runs `link:truapi`, which symlinks a local truapi checkout into `node_modules`. **Please run e2e before merge**: the signing and permission dialogs are now Solid components (labels and order are unchanged, and the e2e helpers click by name).
- SP1: manual pass for you (unchanged from the spec): a toast, a permission prompt, a signing prompt and the password prompt, including keyboard use (Tab stays in the dialog, Escape dismisses only where the backdrop does, focus returns to where it was).
- SP1 result: host startup bundle +126 B gzip, sandbox −362 B, no Solid in any startup chunk; cold start +1.0% (not significant); functional suite 41 passed / 2 skipped.

---

# Sub-project 2 (chat) — spec written while you were AFK

Spec: `docs/superpowers/specs/2026-09-25-solid-v2-sp2-chat-design.md`. You did not
review it; these are my decisions, each with what it costs if wrong.

- SP2-D1 Lazy chat chunk, imported on first panel open and prefetched when idle once the chat button becomes visible. The chat panel code leaves the host startup bundle (today `topbar.ts` statically imports it). Cost if wrong: the first open waits for the chunk if the prefetch hasn't finished.
- SP2-D2 An eager Solid-free controller keeps the button, badge, more-row, window events and the product-iframe width write. Cost if wrong: some state stays outside components until sub-project 4.
- SP2-D3 `aside#chat-panel` stays in `index.html` as an empty container; the button, badge and more-row stay static (they belong to the topbar, sub-project 4). Cost if wrong: one more markup move in SP4.
- SP2-D4 `custom-renderer.ts` and `custom-message.ts` are reused unchanged through a ref. They are the security boundary for product-drawn content. Cost if wrong: they stay imperative code inside a component.
- SP2-D5 Components keep reading rooms, bots and messages through the async `chat/service.ts` getters (no room/message cache in a store). Cost if wrong: a later refactor if we want a store cache.
- SP2-D6 No Playwright chat test: chat needs a logged-in session, which the functional suite cannot create. Chat has no browser-level tests today either. Question: do you want an e2e chat test added once the e2e environment is available?

---

# BLOCKING: sub-projects 3 and 4 need your budget decision

I stopped before sub-project 3 (pages in `#app`) because every path forward is a
guess without your call on the startup budget, which you chose to decide in
SP4 with real numbers. What I found (inventory: `ui.ts` 1,128 lines, eager in
both apps):

- **The landing and error pages are first paint.** `showLanding()` / `showError()`
  run before `dotli:main:end`. Rendering them from a lazy Solid chunk (the
  SP1/SP2 pattern) would delay first paint on the landing page and on every
  error by one chunk fetch (~20 KB gzip), a cold-start regression for those
  paths.
- **Error pages are the failure UI.** One functional test covers "the app chunks
  fail to load mid-session → error page with reload button". An error page
  that itself needs a chunk to load cannot show that error.
- **The sandbox's error/retry screen is its main UI**, and Solid's runtime alone
  (~15.5 KB gzip) is over the sandbox's whole-migration limit (+10 KB).
- The umbrella already has a known conflict: SP4 puts Solid on the host startup
  path, which alone reaches the host's +15 KB limit.

Options for SP3/SP4 (my recommendation first):

1. **Error pages stay imperative on both apps; the landing page and the shell
   become Solid only once Solid is on the host startup path (SP4); raise the
   host limit to about +25 KB; the sandbox keeps no Solid at startup.** The
   failure UI never depends on the framework loading. Reorder: do SP4 before
   SP3, then SP3 moves only the landing page and `activateHost` → root
   disposers. Amend the umbrella's scope ("error pages stay imperative") and
   its host limit.
2. **Everything in SP3 as eager Solid components**, raising the host limit
   (~+25 KB) and the sandbox limit (~+20 KB). Full modernization as originally
   scoped, but both startup bundles grow now and the failure UI depends on
   Solid.
3. **Lazy pages with an imperative fallback** for the chunk-failure case. Keeps
   budgets, but duplicates every error page and delays the landing's first
   paint.

Meanwhile I am running **sub-project 5 (dev-tool panels: truapi-debug and
sandbox-checker)**, which is lazy, off every startup path, and independent of
this decision.

---

# Sub-project 2 (chat) — done while you were AFK

Commits 30d41161..fb6acb1b (spec, plan, 4 tasks, one fix round, one final-review fix wave). Result: the host startup bundle shrank by 1,917 B gzip (the chat panel code left it); the sandbox is unchanged; no Solid in startup chunks; chat chunk 6,035 B gzip; cold start +1.5% (not significant); functional suite 41 passed / 2 skipped.

Rulings made:
- SP2-R1: I wrote and self-approved the SP2 spec and plan (decisions SP2-D1..D6 above). Cost if wrong: you may want a different design. Everything is local.
- SP2-R2: Refetch triggers are new `roomSeq` / `contactsVersion` fields in the chat-panel store, instead of `state/chat.ts` counters. A message for another room no longer reloads the open conversation, which would have dropped live custom-message subscriptions. Cost if wrong: none.
- SP2-R3: The final review covered SP2's commits, plus a check of SP1 components for the Solid 2 dev warning `STRICT_READ_UNTRACKED`. It found one in `ToastCard` (fixed with `untrack`). Cost if wrong: other interactions outside that check could be missed.
- SP2-R4: Left as parity with the old code: the old product's contact list stays visible for a moment after a product switch; a failed contact icon doesn't retry within the same list render; storage read failures are not caught. Cost if wrong: small UX edges.

For you to check: open the chat panel on a chat-capable product while logged in (list, conversation, send, action buttons, a custom message, resize, Escape).

---

# Sub-project 5a (sandbox-checker panel) — done while you were AFK

Commits 900e48ec..4f1404b2. The dev-only violation panel (`VITE_SANDBOX_CHECKER` builds) is now a Solid component in `packages/ui/src/components/sandbox-checker/`. `packages/sandbox-checker/src/sandbox-checker-ui.ts` is deleted. The host startup bundle is unchanged (75,056 B gzip).

Rulings:
- SP5-R1: I split SP5 into 5a (this) and 5b (truapi-debug: about 7,700 lines, no tests, deliberately imperative renderers). 5b pins today's behaviour with tests first. Cost if wrong: SP5 finishes later.
- SP5a-R1: The violation list stays unbounded, as before (dev-only). Cost if wrong: a product hammering a restricted API makes the dev panel sluggish.
- Note: a Solid reactive number child that equals `0` failed to render in tests. The cause is happy-dom 20.14.5's `textContent` setter, not Solid or production. Numeric text children use `String(n)`.

---

# Sub-project 5b (truapi-debug panel) — spec and plan written while you were AFK

Spec `docs/superpowers/specs/2026-09-25-solid-v2-sp5b-truapi-debug-design.md`, plan `docs/superpowers/plans/2026-09-25-solid-v2-sp5b-truapi-debug.md`. My decisions:
- SP5b-D1: characterization tests come first, against today's panel; the Solid panel must pass them unchanged.
- SP5b-D2: the timeline and resolution renderers stay imperative, called through refs. They were written that way to avoid hover and click loss while events stream in.
- SP5b-D3: the detail pane keeps its escaped HTML string builders, rendered through a ref, and is not ported to JSX yet.
- Question: the close button's tooltip says "Hide (Ctrl+Shift+D)", but no such shortcut exists anywhere. Kept verbatim. Should the shortcut be added, or the tooltip fixed?

---

# Sub-project 5b (truapi-debug panel) — done while you were AFK

Commits 1c1bcdb2..883e36ff:
- A 51-test characterization suite pins today's panel.
- Solid-free helpers were extracted into `@dotli/truapi-debug`.
- The panel is re-implemented as Solid components in `packages/ui/src/components/truapi-debug/`, the host imports it, and the old 1,893-line `panel.ts` is deleted.
- The unused `solid-js`/`@solidjs/web` dependencies were removed from `@dotli/truapi-debug` and `@dotli/sandbox-checker`.
- The functional suite gives 41 passed / 2 skipped, and no Solid is in any startup chunk.

Rulings:
- SP5b-R1: The plan's tasks were written as prose (no verbatim code) because of the panel's size. Implementers used the stronger models. Cost if wrong: more review rounds.
- SP5b-R2: Row data was extracted as flat objects, and the escaped markup stays in one place. Cost if wrong: none.
- SP5b-R3: **Host startup bundle +238 B gzip, accepted** (within the umbrella's +2 KB per sub-project). The cause is a Rolldown chunk-splitting decision: the empty `sentry.noop` shim became its own startup chunk once the lazy debug-panel mount also reached it. Adding `sideEffects` to `@dotli/metrics` was tried three ways and gave byte-identical output. Cost if wrong: 238 B on every cold start. Question: do you want me to chase it further (e.g. a `manualChunks` rule), or accept it?
- SP5b-R4: The panel's DOM updates synchronously via Solid's `flush()`, called only from event, animation-frame and timer callbacks. A reviewer judged this safe in Solid 2 RC. It keeps the frozen characterization suite unchanged.
- Left as is: after switching back to the List tab the list jumps to the bottom; hidden list rows keep updating while another tab is shown (dev-only cost); a copy flash can outlive dispose.
- Found along the way: the vitest agent reporter hides console output from passing tests, so Solid dev warnings were invisible. They're now at 0 across all components (checked with `--reporter=default --silent=false`).
- Doc follow-ups not in scope: `DEBUG_PANEL.md` says "three event sources" (there are two) and lists "No export / import" as a limitation (Export exists).

For you to check: open the app with `?debug=true` and use the panel (list, filters, timeline, resolution, dock, resize, export/copy, close).

---

# Where things stand

- Branch `feat/solid-v2-foundation`, 69 commits over `main`, local only (not pushed, per your instruction).
- Done: SP0, SP1 (overlays), SP2 (chat), SP5a (sandbox-checker panel), SP5b (truapi-debug panel).
- **Blocked on your decision: SP3 and SP4** (see "BLOCKING: sub-projects 3 and 4 need your budget decision" above).
- Still needed from you before any merge: the truapi e2e run (the `truapi-host` CLI isn't installed here) and the manual checks listed per sub-project.

---

# Owner decision 2026-09-26: SP3/SP4 — recommendation accepted

Error pages stay imperative (host and sandbox); SP4 runs before SP3; the host whole-migration limit is +25 KB gzip; the sandbox keeps no Solid at startup. The umbrella spec was amended (commit above). SP3 shrinks to the landing page + `activateHost` root disposers.
- SP4-R1: SP4 split into 4a (prerender + hydration of a static Shell), 4b (theme, shield, URL pill, offline, shared popover behaviour), 4c (auth/QR, user, permissions, event unification), 4d (network/chains, settings, autohide, `product-frame-layout.ts`). Spec for 4a: `docs/superpowers/specs/2026-09-26-solid-v2-sp4a-shell-prerender-design.md`.
- SP4-R2: The umbrella's `chat` prerender root is dropped (the chat container has been empty since SP2, and the panel loads lazily).
- SP4a-R1: Sentry init and the global error handlers now run first (from `apps/host/src/boot.ts`), before the rest of `main.ts`'s imports, because hydration must run before `offline.ts` touches `#topbar` and a hydration failure must be reportable. A review found it only adds coverage (errors during module evaluation, early boot code, log breadcrumbs). Cost if wrong: more Sentry events, not fewer.
- SP4a-R2: Solid 2 doesn't throw on a hydration mismatch; it silently creates new nodes. `hydrateRoot` checks that the prerendered top-level elements were the ones claimed, and otherwise falls back to a fresh render and reports to Sentry. A Playwright test checks a production build hydrates without fallback (`#shell[data-hydrated="shell"]`).
- SP4a-R3: **Budget.** After 4a the host startup total was +27,040 B gzip, over your +25 KB limit by 1,440 B. The Solid runtime (all production code) is 21.8 KB, and the shell markup was also shipped as unused JS templates (4.3 KB). Fix: strip those client templates, and on the rare hydration failure restore a snapshot of the prerendered shell. Expected total about +22,786 B. Remaining margin for 4b–4d and 3 is about 2.8 KB, plus whatever imperative topbar code they delete. If later parts can't fit, I'll stop and ask rather than exceed the limit.

## Sub-project 4a (shell prerender + hydration) — done

Commits 40fdc01d..fe1d69d1:
- The shell markup moved from `index.html` into a static `Shell.tsx`, prerendered at build time and in dev.
- It is hydrated at boot, and the imperative topbar code wires the same nodes.
- First paint works with JS disabled (Playwright test).
- Functional suite: 43 passed / 2 skipped.
- Cold start +0.7% (measured before the size fix).
- Host startup total: +22,862 B gzip over the pre-migration baseline, under your +25 KB limit with 2,738 B to spare.
- Sandbox unchanged.

Rulings SP4a-R1..R3 are above. Other notes:
- In Solid 2 rc.9, an uncaught error anywhere halts reactivity for every root on the page. The shell's hydration runs inside an error boundary for that reason.
- The build-time prerender fails loudly and names the component when a prerender breaks.
- The template-strip plugin fails the build if `Shell.tsx` gains reactive code. SP4b must widen it for island components; this is written into the 4b spec.

## Q-SP4b-1 — BLOCKING: host startup budget (asked 2026-09-26, while you were AFK)

**Where things stand:**
- SP4b Task 2 (theme toggle as a Solid island, commit 322ff937) brought host startup to **99,188 B gzip**. That is +24,539 B over the pre-migration 74,649 B, leaving **1,061 B** under your +25 KB limit.
- Eager islands carry their client templates, plus `popover.ts`, `Island.tsx` and `use-store` on the startup path.
- Still to do: the URL pill and shield, the offline banner, 4c (auth/QR/user/permissions), 4d (network/settings/autohide) and SP3 (landing). Done as eager islands, they would clearly go over the limit.

**Per your rule, I stopped before exceeding it.** Options:
- **A: lazy islands (recommended).** The shell stays prerendered and hydrated as static markup, which keeps it cheap and visible at first paint. Interactive pieces then mount from a lazy chunk right after boot, replacing their static copy. Startup stays about flat. Trade-off: a popover click in the first few hundred ms after load would wait for the chunk. A spike is measuring this now; results are below when done.
- **B: raise the limit** (for example to +35 KB) and keep eager islands.
- **C: stop 4b here.** Keep the remaining shell pieces imperative.
- Task 2 review: spec compliant, approved, no Critical/Important. The 5 Minor findings are parked until you answer Q-SP4b-1. Side finding, not caused by 4b: `topbar-autohide.ts` has never checked whether the theme menu is open.
- **Spike result (lazy islands):**
  - Startup: 97,619 B, against 99,189 B for the eager island. That leaves 2,630 B under your limit.
  - The lazy chunk is 2,273 B.
  - Each further island costs about 0 B at startup when lazy, against about 1–3 KB when eager.
  - Full write-up: branch `spike/lazy-islands` (throwaway, not merged).
- **Ruling SP4b-R1:** proceed with option A (lazy islands, plus replay of clicks that arrive before an island mounts). Rationale:
  - Your stop rule is about *exceeding* the limit, and option A stays under it.
  - Option A is reversible and keeps the no-JS first paint byte-identical.
  - It also fixes the hydration-fallback case for free.

  If you prefer option B (raise the limit, keep islands eager), say so. Commit 322ff937 has the eager version.

  Spec amended with decisions 14–18; plan amended with Task 2b.

## Sub-project 4b (theme, URL pill, shield, offline banner): implemented, final review running

**Result:** the theme toggle, the URL pill with the verification shield, and the offline banner are now lazy Solid islands. The old imperative code is gone.

**Sizes:**
- Host startup is 96,667 B gzip: 843 B below the end of 4a, and +22,018 B over the pre-migration baseline (limit +25,600 B, so 3,582 B to spare).
- Sandbox: +1 B.

**Tests and timing:**
- Cold start: −1.2%.
- Functional suite: 43 passed, 2 skipped.

**Behaviour changes, all small:**
- Escape closes the theme menu from anywhere, not only with focus inside it.
- The URL pill appears once the islands chunk has loaded; it is fetched at boot.
- If that chunk fails to load, the pill stays hidden. It never shows anything wrong, and the failure goes to Sentry.

**Other rulings (SP4b-R2 to R4):**
- **R2:** no retry of a failed chunk load. Browsers cache the failed module fetch, so a retry does nothing, and cache-busting could load a second copy of the stores.
- **R3:** if you are offline at boot, a tiny Solid-free fallback (+83 B) still shows the offline banner.
- **R4:** Task 5's re-review was done by the controller: a single-file test diff that had been mutation-checked.
- **4b final review:** ready to merge, no Critical or Important findings. The fix wave (87a2b646, 650a9df9) hardened the islands mount:
  - each island is isolated from the others;
  - a missing static node is reported to Sentry;
  - focus carry-over now works in real browsers;
  - an ESLint rule bans Solid-delegated `on*` events in `components/shell/**`.

  The scoped re-review found everything addressed. Host startup is 96,631 B.
- **Carry-forward to 4c and 4d:**
  - Extend the ESLint `on*` rule's files glob when an island lives outside `components/shell/`.
  - An island with two static nodes that throws mid-swap leaves the already-swapped node inert. This is documented and accepted, the same shape as SP4b-R1's post-swap error.
  - Parked: a failed lazy chunk is reported to Sentry twice (the `vite:preloadError` handler plus the loader). The chat and overlays loaders do the same, so fix all of them together.
  - Every new island must be a trigger id plus a static node in `Shell.tsx`. Use native listeners only.

## Sub-project 4c (auth button, QR pairing, user popover, permissions popover): in progress

The spec and plan are committed (9921c840) and written by the controller. The plan has 5 tasks. The decisions that change behaviour:
- **SP4c-D4:** the auth button stays "Connecting..." (disabled) until the islands chunk mounts, which is fetched at boot. Today it is enabled at boot.
- **SP4c-D6:** the user popover gains a focus trap and Escape handling, matching the permissions popover. This applies your SP1 answer, "Consistent a11y". Say if you'd rather keep today's behaviour, where the user popover has no trap.
- **SP4c-D12:** if the islands chunk fails to load, login is unavailable. This is reported to Sentry. It is consistent with the 4b rulings, because a page that can't fetch a chunk can't pair either.
- There is no QR refresh timer today, and none is added. The inventory looked for one and found nothing in the JS layer.
- **4c implemented** (8176cd04..be2e89c1). Every task passed review with no Critical or Important findings. The final whole-branch review is running.
  - Host startup: **93,886 B** (−2,747 B against the end of 4b). That is +19,237 B over the pre-migration baseline, with 6,363 B to spare.
  - Sandbox: +8 B.
  - Cold start: +2.47%, within the 5% gate.
  - Functional suite: 43 passed, 2 skipped.
  - e2e selectors checked by reading only; e2e cannot run here.
- **Rulings:**
  - **SP4c-R1:** autohide decides "logged in" from the login store instead of querying for `.user-badge`. The badge now appears after autohide arms, so the old query would never start the hide timer.
  - **SP4c-R2:** `#user-popover` gets `tabindex="-1"`, which the new focus trap needs.
- **4c final review:** "with fixes", with 1 Important finding. If the islands chunk failed to load, a product-started login held the blocking-modal lease forever, so every later host prompt hung. The fix is committed (4f32f4b2 + 07463e3d): `disableAuthModal()` releases the lease and cancels later logins. The re-review found it fully addressed. Host startup is now **93,977 B**. **4c is done.**
- **Carried forward to 4d:**
  - `trapPopoverFocus` in `topbar.ts` now serves only the mode popover, and should retire with it.
  - Move the focus helpers into a Solid-free `components/shell/focus.ts`.
  - Add `#mode-button` and the chains button to the loader's `TRIGGERS`.
  - Extract `initMoreMenu()` so the tests stop emulating the More row.
  - Optionally have `mountIsland` return whether the swap happened.
  - Parked: the `account.ts` session fallback edge case, and the double Sentry report on chunk failure.

## Sub-project 4d (frame layout, autohide, chains, settings, "more"): in progress

Spec and plan committed in 76aba4dc (controller-written, 6 tasks).

**Decisions that change behaviour.** Each one fixes a pre-existing bug:
- **SP4d-D1:** one module now owns the product iframe geometry.
  - Chat width now respects left and right safe-area insets.
  - A product reload with chat open keeps the narrowed width. Before, the width was reset, and whether it came back depended on the order the listeners ran.
- **SP4d-D2:** autohide now counts the chains/network popover as open.
  - The bar no longer hides under an open chains popover.
  - The reveal shortcut no longer hides the bar beneath that popover.
- **SP4d-D3:** the chains popover gains a focus trap, and focus returns to its button on close, matching the other popovers.

**Other rulings:**
- **SP4d-D2:** autohide stays Solid-free. It is behaviour, and it has no static markup.
- **SP4d-D9:** all islands stay in one lazy chunk. If that chunk goes over 20 KB gzip after 4d, splitting it is brought back to you as a finding.

## Finding (not caused by the migration): `host-settings.spec.ts` is stale, and CI does not run it

Five tests fail on this branch, and they already failed at the end of 4c (07463e3d): lines ~116 and ~217, and ~266 on each of the 3 backends. `bun run test:functional` in `apps/host/package.json` does not list this spec, so the "43 passed" runs never included it.

Root causes:
- **Lines 116 and 217** expect default values in the URL. `writeSettingsToSearch` removes default values from the URL (`packages/config/src/url-settings.ts:110-132`), and `smoldot-direct` has been the default since 9a4ea273.
- **Line 266:** `helpers/cache.ts:29` opens `indexedDB.open("dotli", 1)`, but the DB is at version 4. The call throws a VersionError, so the helper reports "not cached".
- **`waitForCachedCid` does nothing.** `page.waitForFunction` does not await a Promise; a returned Promise just counts as truthy.

The proposed fix only touches tests:
- `indexedDB.open("dotli")` with no version;
- `expect.poll(() => hasCachedCid(...))`;
- lines 133 and 237 assert `not.toContain("chainBackend=")` and `not.toContain("skipWorkerCache=")`.

I have **not** applied it, because it is outside the migration. **Question for you:** should I fix it on this branch, or in a separate PR from main? The bug exists on main too.

Full evidence: `scratchpad/host-settings-bisect.md` in the session scratchpad.

## Owner instruction (2026-09-27)
- "please stop doing this extencive performance checks after each step ... check in the end of sub project". From now on, per-task work runs only typecheck, lint and unit tests. Size builds, Playwright and cold start run once, in each sub-project's final verify task.

## Sub-project 4d: done (76aba4dc..17bb7a79)

**Results**
- Host startup: **90,431 B**, which is +15,782 B over the pre-migration baseline (9,818 B under your limit).
- Sandbox: +1 B.
- Cold start: −2%.
- Functional suite: 43 passed, 2 skipped.
- `topbar.ts` is now 80 lines of boot wiring.
- The product iframe geometry has one owner.

**Final review:** it found 1 Important issue. A settings sheet opened before the settings finished loading stayed empty, with no close button on phones. It is fixed in 1d91adb8, and the re-review is clean.

**Pre-existing bugs fixed along the way**
- Chat width now respects the safe-area insets.
- A product reload no longer loses the chat width.
- The topbar no longer auto-hides under an open chains popover.
- The debug dock and the chat panel no longer overwrite each other's frame geometry.

## Sub-project 3 (landing page, loading screen, activateHost root disposers): in progress

The spec and plan are committed in 0bafd4ef. The controller wrote them. There are 5 tasks, and only the last one runs the performance checks.

**Decisions:**
- **SP3-D3:** the loading screen becomes a lazy island, not prerender plus hydrate as the umbrella Roots table said. The reason is the one behind 4b Amendment D14: eager reactive markup costs startup bytes. The static loading markup stays in `index.html` as the first paint without JavaScript.
- **SP3-D4:** the landing page is its own lazy chunk. If that chunk fails to load, the error page offers a reload. Before this change, the landing code was on the startup path.
- **SP3-D1:** the error pages stay imperative, but they now dispose the tracked roots first. This fixes a leak that predates the migration: on the "no content" error page, the loading timers kept running.

## Sub-project 3: done (0bafd4ef..d92315f3)

**Results**
- Host startup: **89,161 B**, which is +14,512 B over the pre-migration baseline and 11,088 B under your limit.
- Sandbox: −219 B, and it contains no Solid.
- Cold start: −4.5%.
- Functional tests: 43 passed, 2 skipped.
- New chunks: landing 3,427 B and islands 17,224 B.

**Final review:** it found 1 Important issue. The static loading spinner's rAF was never stopped on the landing, preview and early-error paths. That is fixed in 20381d04, and the re-review is clean. The umbrella spec was amended in d92315f3.

**Pre-existing bugs fixed along the way**
- Loading timers leaked on the "no content" page.
- A document listener on the landing page was never removed.
- Late loading signals restarted timers after the loading screen was gone.
- Load telemetry read 0 on slow loads.

## ALL PLANNED SUB-PROJECTS DONE: waiting on you

The migration covers SP0, SP1, SP2, SP5a, SP5b, SP4a–4d and SP3. The final review of SP3 found nothing left imperative that isn't meant to be.

All work is on the local branch `feat/solid-v2-foundation`. Nothing has been pushed.

**Needs you before merge or PR**
1. **Push and PR.** The branch is local only. Say when to push it and open the PR.
2. **Run the e2e suite.** It needs the `truapi-host` CLI, which isn't installed here. The e2e selectors were checked by reading only.
3. **Q-SP4b-1.** I ruled for lazy islands (option A) instead of raising the limit. Please confirm.
4. **SP4c-D6.** Superseded: the user popover is now a non-modal Radix-style popover.
5. **Stale `host-settings.spec.ts`.** Fixed on this branch (see Owner decisions).
6. **Uncommitted change in `docs/perf/solid-migration-baseline.md`.** It is a table re-alignment. It isn't mine; revert it or keep it.
7. **Leftover spike branch.** The throwaway `spike/lazy-islands` branch and its worktree under `.claude/worktrees/` can be deleted. I haven't touched them.
8. **Manual checks from earlier sections**, and any answers still open above.

## Owner decisions (2026-09-27)
- **Stale settings tests:** fix them on this branch. Done in 9ad84f3a (28/28 twice). `ui-smoke` and `host-settings` are now also run and gated in CI (13138e37).
- **Size:** "raise limit only". The migration limit is now +35 KB (4c926937). I chose the number, so tell me if you want a different one.
- **Popovers:** Radix-style focus, per Radix type. This supersedes SP4c-D6. **Done**, in commits c4d3aef4..fad59e90:
  - **Tests:** functional 71 passed, 2 skipped. UI tests 1010/1010.
  - **Size:** host startup 89,175 B, +11 B against the end of SP3. The islands chunk is 18,024 B gzip.
  - **Reviews:** the final review found two Important issues, both fixed, and the re-review was clean.

## Radix focus: needs you
1. **Firefox check.** Press Space on the theme button and the ⋯ (More) button. The menu should open and stay open, with the first item focused. The fix is covered by unit tests only.
2. **Phone check, iOS and Android.**
   - Open the user popover or the theme menu on the landing page.
   - Tap empty space: it should close.
   - Start a scroll outside it: it should stay open.
3. **Behaviour changes to confirm or reject:**
   - **Sign-in modal:** it now opens with Cancel focused, and a press outside it cancels the login.
   - **Verification shield:** it stays a disclosure, not a dialog.
4. **User popover accessible name.** It is "Welcome back", taken from its heading. Give me better wording if you want it changed.
5. **Left out on purpose. Say if you want any of them:**
   - Tab out of a popover does not return to its trigger. This matches Radix's portalled Popover.
   - Open menus and dialogs do not hide the rest of the page from screen readers the way Radix does. Only `aria-modal` is set.
   - The settings mode does not change if the window is resized while it is open.
   - A scroll between a touch and its tap cancels the close.

## Chat custom renderer on Solid (b4ef6342)
- Done: `CustomNode` + `CustomMessage` replace the vanilla renderer. Text fields keep focus, caret and typed text across product updates (owner request).
- **Behaviour change to know about:** a field's value is now written only when the product sends *different* text. A product that never echoes typed text and re-sends `text: ""` to clear the field after "Send" will leave the typed text in place; it must send a changed value (or echo, then clear). Previously every update reset the field.
- Known limit (unchanged from before): a late echo of older text can still overwrite faster typing.
- No Playwright spec covers chat; only unit tests (1026 UI tests pass). Chat chunk +291 B gzip, host startup unchanged.
