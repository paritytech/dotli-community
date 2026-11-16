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
- [designs-compete-on-a-measurable-cost](designs-compete-on-a-measurable-cost.md): a simple design competes with
  elaborate ones that guard a size or a setup.
- [rule-a-check-could-hold](rule-a-check-could-hold.md): a rule could be a lint rule or a test, and the docs seem to
  need it too.

## Code structure

- [existing-call-needs-a-variant](existing-call-needs-a-variant.md): a shared primitive needs a second form of a call
  that differs in one aspect.
- [files-away-from-their-feature](files-away-from-their-feature.md): files that serve one feature sit in a top-level
  folder filed by kind.
- [grouping-source-into-folders](grouping-source-into-folders.md): an app's source gets folders, and the question is how
  much structure.
- [import-cycle-between-folders](import-cycle-between-folders.md): two folders import each other.
- [protocol-callbacks-serve-several-features](protocol-callbacks-serve-several-features.md): an external protocol's
  callbacks each serve a different feature.
- [two-kinds-of-module-share-a-name](two-kinds-of-module-share-a-name.md): a view and its island, or a similar pair, end
  up with the same name.

## UI

- [screen-mixes-alignments](screen-mixes-alignments.md): a screen has some text centred and some at the start edge.
