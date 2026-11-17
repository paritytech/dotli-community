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
- [cleanup-move-matches-a-rule](cleanup-move-matches-a-rule.md): a simplification pass finds a shape that matches one
  of its rules, or a rater lists it.
- [designs-compete-on-a-measurable-cost](designs-compete-on-a-measurable-cost.md): a simple design competes with
  elaborate ones that guard a size or a setup.
- [owner-approves-in-advance](owner-approves-in-advance.md): the owner approved a change in advance, and its gates or a
  follow-up change on the same branch would stop for approval.
- [rule-a-check-could-hold](rule-a-check-could-hold.md): a rule could be a lint rule or a test, and the docs seem to
  need it too.

## Code structure

- [branch-left-unreachable-by-a-removal](branch-left-unreachable-by-a-removal.md): removing a table entry leaves one
  variant of a mechanism, and the branches and tests it drives, with nothing that reaches them.
- [cleanup-rewrite-that-reads-no-better](cleanup-rewrite-that-reads-no-better.md): a simplification pass or a review fix
  finds a style or skill rule that matches the code's shape, such as one event that carries a collaborator's state, and
  the rewrite it describes would read no better than the code it replaces.
- [entry-the-product-no-longer-supports](entry-the-product-no-longer-supports.md): support for one name of an external
  protocol's set is dropped, several pieces of logic walk the catalog built on those names, and a choice may be left
  unreachable.
- [existing-call-needs-a-variant](existing-call-needs-a-variant.md): a shared primitive needs a second form of a call
  that differs in one aspect.
- [files-away-from-their-feature](files-away-from-their-feature.md): files that serve one feature sit in a top-level
  folder filed by kind.
- [grouping-source-into-folders](grouping-source-into-folders.md): an app's source gets folders, and the question is how
  much structure.
- [import-cycle-between-folders](import-cycle-between-folders.md): two folders import each other.
- [parameters-only-valid-together](parameters-only-valid-together.md): a function takes a nullable parameter and a
  second one, often a callback, used only when the first is set, so a caller without the first passes a stand-in.
- [protocol-callbacks-serve-several-features](protocol-callbacks-serve-several-features.md): an external protocol's
  callbacks each serve a different feature.
- [stored-value-an-older-version-wrote](stored-value-an-older-version-wrote.md): a store the page does not migrate holds a
  value an older version wrote that the UI no longer offers.
- [two-kinds-of-module-share-a-name](two-kinds-of-module-share-a-name.md): a view and its island, or a similar pair, end
  up with the same name.

## Product requests

- [permission-request-the-host-no-longer-offers](permission-request-the-host-no-longer-offers.md): a product requests a
  permission the host removed from its UI because the capability cannot work where products run.

## UI

- [element-spans-a-shared-primitives-padding](element-spans-a-shared-primitives-padding.md): an app wants an element
  that runs edge to edge across a shared container primitive, past its inner padding.
- [icon-text-and-controls-in-one-row](icon-text-and-controls-in-one-row.md): a card or row has a leading icon, a title
  over a body and trailing controls taller than the title's line.
- [screen-mixes-alignments](screen-mixes-alignments.md): a screen has some text centred and some at the start edge.
- [window-blur-closes-a-popover](window-blur-closes-a-popover.md): a shared layer closes a popover on every window blur,
  and it also closes when the browser's own UI or another app takes focus.
