# Decisions

How the owner resolves scenarios that come back during development. Each file tells one story: what a developer runs
into, the steps that resolve it and the owner's reason, with an example and the cases that taught it. A rule is a
breadcrumb toward an answer, not the record of what one change chose.

The `oracle` agent owns this folder and keeps this index in step with it. No session reads the folder at start. A
session reaches it only through the oracle, when a question comes up.

The owner may change or remove any rule. A change here lands in the same commit as the work that caused it.

## Workflow

- [agent-runs-a-skill-that-asks](agent-runs-a-skill-that-asks.md): an agent with no direct line to the owner runs a
  skill that asks the user.
- [design-records-what-the-owner-said](design-records-what-the-owner-said.md): a design document records the owner's
  goal and answers, and the question is whether it quotes the owner's words or restates them.
- [designs-compete-on-a-measurable-cost](designs-compete-on-a-measurable-cost.md): a simple design competes with
  elaborate ones that guard a size, a setup or a first-visit cost, while building rather than in a cleanup.
- [new-skill-for-one-kind-of-file](new-skill-for-one-kind-of-file.md): a new skill tells agents how to plan and write
  one kind of file, with a contract doc for that kind, and the question is how the agents that write it come to run the
  skill and where the reviewer's rows for that kind of file live.
- [owner-approves-in-advance](owner-approves-in-advance.md): the owner approved a change in advance, and its gates or a
  follow-up change on the same branch would stop for approval.
- [rule-a-check-could-hold](rule-a-check-could-hold.md): a rule could be a lint rule or a test, and the docs seem to
  need it too.
- [slice-edits-an-end-to-end-spec](slice-edits-an-end-to-end-spec.md): a slice edits a Playwright spec that drives the
  built app, and the question is whether the slice's checks run it.
- [workflow-dispatches-several-subagents](workflow-dispatches-several-subagents.md): a workflow dispatches several
  subagents for one change, and the question is which loads the code-writing docs and who runs the loop.

## Browser support

- [fallback-for-a-floor-era-browser](fallback-for-a-floor-era-browser.md): a cleanup finds a fallback for a feature
  Safari 17.4 has but another browser of the same era lacked, and the question is whether the floor binds only Safari.

## Build

- [build-feature-the-framework-lacks](build-feature-the-framework-lacks.md): a build step would fill a gap in the
  framework, such as post-processing its emitted pages, and the question is whether to write custom code and how it
  reacts when the framework's output stops matching.
- [source-an-embedded-interpreter-evaluates](source-an-embedded-interpreter-evaluates.md): a package hands source to an
  embedded interpreter VM, such as code defining the VM's own globals, and the question is whether the rule against
  shipping JavaScript as a string covers it.

## Code structure

- [cap-how-often-readings-reach-state](cap-how-often-readings-reach-state.md): a page component caps how often a stream
  of input readings, from one or more sources, reaches its state, latest reading winning, and the question is where the
  cap lives when the rules ban hand-rolled timers and point at the task pool.
- [author-metadata-the-rfc-does-not-name](author-metadata-the-rfc-does-not-name.md): a product page adds a piece of the
  author's metadata the product-manifest RFC does not name, and the question is whether it is read while the product
  resolves or when the author card opens, and where it is kept.
- [cleanup-rewrite-that-reads-no-better](cleanup-rewrite-that-reads-no-better.md): a simplification pass or a review fix
  finds a style or skill rule that matches the code's shape, or a rater lists it, and the rewrite it describes would
  read no better than the code it replaces, or would drop a guard that keeps idle work from running. Also how to correct
  a pass that made code read worse.
- [code-reads-or-writes-web-storage](code-reads-or-writes-web-storage.md): code keeps a value in local or session
  storage through direct `SafeStorage` calls, and the existing persist adapter lacks something the value needs, such as
  telling whether a write stuck.
- [component-reports-before-it-restores](component-reports-before-it-restores.md): a component that boots asynchronously
  reports an empty state before it restores what it stored, and a display, a cache or a watcher reading the layer above
  acts on that gap, including when the layer above's own store-changed nudge causes it.
- [domain-free-runtime-one-app-uses](domain-free-runtime-one-app-uses.md): a runtime with no domain, such as an
  interpreter VM with its worker entry, is used by one app through a domain-specific unit on top, and the question is
  whether it lives in the app's feature, an existing package or a new package.
- [entry-the-product-no-longer-supports](entry-the-product-no-longer-supports.md): support for one name of an external
  protocol's set is dropped, several pieces of logic walk the catalog built on those names, and the protocol can still
  send the name, so the question is how to keep it out of all of them and which answer the request gets.
- [existing-unit-needs-a-variant-or-another-value](existing-unit-needs-a-variant-or-another-value.md): a shared unit,
  such as a machine's call, a shared layer or a listener helper, must do its work in a way that differs in one aspect,
  or report one more value from the same events.
- [fact-about-each-network](fact-about-each-network.md): UI depends on a fact about the network the visitor picked, such
  as whether its tokens have value, and the network table holds no field for it.
- [grouping-source-into-folders](grouping-source-into-folders.md): an app's source gets folders, and the question is how
  much structure, or files that serve one feature sit in a top-level folder filed by kind, or a helper's only caller
  moves to another feature, or several features come to read through a helper built on a low feature's infrastructure.
- [hold-kept-while-a-core-has-open-work](hold-kept-while-a-core-has-open-work.md): a callback adapter takes a page-wide
  hold while a protocol core has begun work it has not ended, the core's runtime never ends that work at teardown or on
  a fault, and the question is what releases the hold.
- [import-cycle-between-folders](import-cycle-between-folders.md): two folders import each other.
- [moved-helper-reads-what-its-new-home-holds](moved-helper-reads-what-its-new-home-holds.md): a helper moves into
  another feature with its only caller, and it still reads and caches data itself that the new feature already holds for
  as long as the helper can be asked.
- [new-outcome-in-an-existing-flow](new-outcome-in-an-existing-flow.md): a new reaction, such as an automatic reload,
  joins a signal an existing flow already turns into an outcome, such as a failure screen, and the question is whether
  it gets a module of its own or a state of its own, where its action runs, and where a choice that needs a call with a
  side effect, such as a one-time claim, is made.
- [page-wide-behaviour-on-an-island-page](page-wide-behaviour-on-an-island-page.md): an Astro page of static markup and
  islands needs a DOM behaviour that spans the whole page, and the question is whether the entry module, an island or a
  page `<script>` starts it.
- [parameters-only-valid-together](parameters-only-valid-together.md): a function takes a nullable parameter and a
  second one, often a callback, used only when the first is set, so a caller without the first passes a stand-in.
- [protocol-callbacks-serve-several-features](protocol-callbacks-serve-several-features.md): an external protocol's
  callbacks each serve a different feature.
- [security-critical-config-to-a-sandboxed-child](security-critical-config-to-a-sandboxed-child.md): a sandboxed child
  reads config from its parent through URL params any embedder can write, and one value is security-critical.
- [read-serves-sources-of-different-trust](read-serves-sources-of-different-trust.md): one read checks what a caller's
  source returns, such as hashing blocks against their ids, and its callers' sources differ in trust, so the question is
  whether the read picks the check or each caller wraps its own source.
- [stored-value-an-older-version-wrote](stored-value-an-older-version-wrote.md): a store the page does not migrate holds
  a value an older version wrote that the UI no longer offers.
- [two-kinds-of-module-share-a-name](two-kinds-of-module-share-a-name.md): a view and its island, or a similar pair, end
  up with the same name.
- [unit-whose-only-wait-is-its-own-timer](unit-whose-only-wait-is-its-own-timer.md): a small unit, such as a rate
  limiter, has one phase that outlives a call, a timer it set, with no await or failure path, and the question is
  whether it runs on `createStateMachine` and what shape its state takes.
- [view-shows-a-status-the-layer-already-reports](view-shows-a-status-the-layer-already-reports.md): a view shows each
  item's status, and the state layer's existing verdict, which other readers share, reports a waiting state the view
  would rather not show, such as a brief one after the page returns from hidden or one for an item nothing on the page
  holds.
- [what-a-removal-leaves-unreached](what-a-removal-leaves-unreached.md): a removal leaves something nothing reaches or
  only one reader reads, such as a variant no entry uses or an unselectable choice. It covers a flow that still waits on
  and records a fact that no longer decides its step, once another layer owns the capability.

## Product requests

- [generated-codec-misses-a-served-version](generated-codec-misses-a-served-version.md): the host reads protocol
  messages with a dependency's generated codecs, which cover only the newest envelope version, while the bundled core
  still serves older ones.

## Tests

- [a11y-check-a-story-file-does-not-need](a11y-check-a-story-file-does-not-need.md): a story file's axe check costs time
  or fails where it has nothing to find, such as stories that drive a component at capacity near the test timeout, or
  the contrast rule on text inside a decorative, `aria-hidden` background graphic.
- [play-asserts-a-number-shown-as-plain-text](play-asserts-a-number-shown-as-plain-text.md): a kept story play is the
  only guard of an edge case about a number the component shows as plain text, with no role, accessible name or `data-*`
  state, and lint refuses `toHaveTextContent` in story files.
- [play-checks-a-prop-reaches-an-aria-state](play-checks-a-prop-reaches-an-aria-state.md): a story play checks that a
  state prop, such as `disabled`, lands as an ARIA attribute that is the only way assistive technology learns the state,
  and the question is whether the stories contract drops it as a prop passed through or keeps it as a behaviour a user
  sees.
- [test-for-where-a-view-keeps-its-scroll](test-for-where-a-view-keeps-its-scroll.md): a scrolled view keeps the reader
  at a place, such as the newest message, as its content or size changes, and the only story test needs heavy browser
  setup, so the question is whether to keep the plays, move the logic behind a unit spec or test it not at all.

## UI

- [decoration-joins-a-presentational-component](decoration-joins-a-presentational-component.md): an optional decoration,
  such as a badge, joins a presentational piece of UI, such as a logo, that has one root or several forms callers
  assemble from parts, and the question is where it sits and where the caller's `class` and test id go.
- [decorative-graphic-draws-real-entities](decorative-graphic-draws-real-entities.md): a decorative graphic shows live
  entities the app observes beside simulated filler, and the question is how real entities come into view, how they may
  be linked and how the filler relates to them.
- [component-drawn-smaller-in-one-place](component-drawn-smaller-in-one-place.md): a feature's component with one fixed
  size, such as an avatar with a fallback letter, is needed smaller in one view while its other users keep the standard
  size, and the question is whether it takes a `size` prop or a caller's `class`.
- [design-gives-px-line-heights](design-gives-px-line-heights.md): a design's type scale pairs each size with a fixed px
  line height, and the tokens hold a few line-height ratios that places pair with sizes.
- [closing-a-panel-focuses-an-auto-hiding-bar](closing-a-panel-focuses-an-auto-hiding-bar.md): a panel returns focus to
  its button on close, the button sits in a bar that shows itself when focus enters it, and a pointer close unfolds the
  folded bar, so the question is whether the bar or the panel's focus return changes, and whether the panel or its
  opener owns the return.
- [compound-primitive-needs-labelled-sections](compound-primitive-needs-labelled-sections.md): a shared compound
  primitive renders a flat list, and a caller needs several kinds of items under visible headings in one list.
- [dim-a-graphic-of-overlapping-parts](dim-a-graphic-of-overlapping-parts.md): a decorative graphic of overlapping
  parts, such as dots on lines, must look faint against the page, and the question is where the faintness goes.
- [feature-with-its-own-color-tokens-adopts-a-design](feature-with-its-own-color-tokens-adopts-a-design.md): a feature
  with its own family of color tokens adopts a design whose colors the family does not hold, and close general tokens
  exist, or one of the design's text colors fails contrast on its surface.
- [entry-animation-follows-a-measured-side](entry-animation-follows-a-measured-side.md): a shared surface's entry slides
  toward a side known only after the shown surface is measured, so the first entry on a new side slides a few pixels the
  other way.
- [element-spans-a-shared-primitives-padding](element-spans-a-shared-primitives-padding.md): an app wants an element
  that runs edge to edge across a shared container primitive, past its inner padding.
- [existing-component-already-does-the-job](existing-component-already-does-the-job.md): a primitive is changed to do
  something another component of its package already does, that component has a gap such as a missing browser fallback,
  and the question is whether to fill the gap or keep the old way.
- [listbox-option-needs-a-remove-action](listbox-option-needs-a-remove-action.md): a combobox's popup is a shared
  listbox primitive, and each row needs a remove action though an option may not hold a control.
- [list-row-opens-a-detail-beneath-it](list-row-opens-a-detail-beneath-it.md): a list row with a rich header opens a
  detail under it on press, and the shared disclosure primitive's header takes only a string.
- [focus-ring-only-for-keyboard-focus](focus-ring-only-for-keyboard-focus.md): a focus ring should show only for
  keyboard focus, the browser matches `:focus-visible` on a clicked text field, and the question is whether to build an
  input-modality tracker instead.
- [icon-text-and-controls-in-one-row](icon-text-and-controls-in-one-row.md): a card or row has a leading icon, a title
  over a body and trailing controls taller than the title's line.
- [identity-row-with-a-name-and-an-address](identity-row-with-a-name-and-an-address.md): a row shows an entity that
  always has a raw address and may have a human-readable name, and the question is whether it shows both or one.
- [light-dismiss-popover-closes-when-it-should-not](light-dismiss-popover-closes-when-it-should-not.md): a popover on
  the shared floating layer closes on a window blur that did not go into an embedded app, or on a press on an anchor
  that cannot be its invoker, such as a text field.
- [match-an-on-screen-reference](match-an-on-screen-reference.md): the owner asks for UI done like something already on
  screen, and the question is whether a close or moved version is enough before presenting, or whether a shared
  component's fixed placement may stay a pixel or two off at one caller's size.
- [one-form-of-a-responsive-component-changes](one-form-of-a-responsive-component-changes.md): a shared component with a
  wide-screen form and a phone form needs a different primitive on one form only, and the question is where the switch
  between the forms lives, what ARIA its trigger carries and which keys it handles.
- [page-mode-moves-a-shared-component](page-mode-moves-a-shared-component.md): an app's page mode moves where a
  component of the domain-free shared UI package sits, such as a side panel that must start below a band of changing
  height, and the question is how the component learns its new placement.
- [screen-mixes-alignments](screen-mixes-alignments.md): a screen has some text centred and some at the start edge.
- [section-whose-data-loads-lazily](section-whose-data-loads-lazily.md): a card or popover section's data loads only
  after the card opens, and the question is what the section shows while it loads.
- [status-mark-drawn-around-an-icon](status-mark-drawn-around-an-icon.md): a design carries an entity's state in a disc
  or ring around its icon, and the question is whether that breaks the rule that icons stand bare.
- [surface-available-while-its-run-restarts](surface-available-while-its-run-restarts.md): a panel and its button show
  while a background run has registered for the item on screen, and the question is whether they hide when the run ends
  for a transient reason and restarts, or stay available while an action in the gap fails.
- [surface-placed-against-its-trigger](surface-placed-against-its-trigger.md): a shared surface that opens from a
  trigger, such as a dropdown or a tooltip card, places itself in its own way or must line up with the edge of the bar
  its trigger sits in, and the question is how a host places it or what carries the bar's edge into the component.
- [shared-component-text-prop-needs-rich-content](shared-component-text-prop-needs-rich-content.md): a shared component
  draws a string prop inside its own chrome, such as a drawer's title beside its close button, and one consumer needs
  markup there that changes with its state, so the question is whether to add a second prop or widen the one it has.
- [markup-in-a-shared-components-head-row](markup-in-a-shared-components-head-row.md): a consumer passes its own markup,
  such as a back button and an avatar, into a shared component's head row beside its small control, and the question is
  how large it may be when the head shifts as the consumer switches states.
- [static-page-content-a-runtime-setting-gates](static-page-content-a-runtime-setting-gates.md): a page rendered at
  build must show a piece of content only when a setting the visitor picks at runtime says so.
