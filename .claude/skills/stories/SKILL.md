---
name: stories
description: >-
  Use before writing a Storybook story file (`*.stories.tsx`) in `apps/` or `packages/`, before adding a story or a play
  to one, and before rewriting one, including the stories of a new component. It decides whether the component earns
  stories at all. It then plans the file as a table of distinct states before any story is written, and builds the
  stories from args. Skip it for an edit that only follows a rename made elsewhere.
---

# Stories

Plan a story file before writing it, then build it from args. The contract is `docs/code/stories.md`. This skill runs
it.

## Step 1: Read the contract

Read `docs/code/stories.md` whole. Its clause IDs (V, K1, K2, C1 to C4) are the ones the table below uses.

## Step 2: Does the component earn stories?

Check it against § Which components get stories. A component that only fills in another component's props gets no story
file. Stop there and say which component's stories already show its looks. Composed content goes on.

## Step 3: Read the component, not the nearest story file

Read the component and its props type. Then read the story files of the components it puts together, since a parent
imports a child's story args from that child's file. Never take another story file as the template for this one, since
the largest files are the oldest and break the contract most.

The two exemplars are the only story files to model on. Read the one closer to the component:

- `packages/ui/src/components/primitives/SegmentedControl.stories.tsx` for a primitive. `meta` holds the default args
  and one render that owns the controlled value, a decorator adds what Tab lands on, and each play is one keyboard or
  pointer behaviour found by role and name.
- `apps/host/src/features/network/ChainsContent.stories.tsx` for a feature panel. The panel's states are args on a
  popover decorator, its chains come from the child row's story args, and only the plays that open the popover or move
  the network over time render it in the bar and read a fixture.

## Step 4: Plan the table

One row per state the component can show:

| State | Why it is distinct | Story, play or unit spec | Clause |
| ----- | ------------------ | ------------------------ | ------ |

- Walk § Which states a file shows. Each "show" entry that applies is a row. Each "skip" entry removes rows.
- A row that looks like another row goes, and so does a row that only changes copy.
- A row whose behaviour needs heavy setup in the browser is a unit spec, and the logic moves behind a seam.
- A play row names V, K1 or K2. A row that would only fit C1 to C4 is a story with no play, or no row at all.
- When adding to an existing file, plan only the new rows, checked against the stories the file already holds.
- When rewriting an existing file, give each old story the row it became or the clause that drops it.

When the work runs as a slice of an `architecture` change, the table goes in the slice report, so the owner reads it at
the stop.

## Step 5: Write the file

- `meta` holds the default args, from the fixtures, and the decorators for the frame the component sits in.
- A story is its args, built on another story's with `...Base.args` where it differs from it.
- A play holds one behaviour, finds elements by role and name, and asserts a role or a state.
- A rewrite that leaves no copy assertion drops the file's `eslint-disable no-restricted-properties` line.

## Step 6: Check

From the repo root, run the file's story tests with `npx vitest run --config vitest.storybook.config.ts <file>`, then
lint the workspace the file lives in. Every row of the table is a story, a play or a unit spec in the diff.

## Red flags

- A story file opened as the template for a new one.
- A `render` in each story where a decorator on `meta` would do.
- One story per value of a prop that Controls shows.
- A story of a component that only fills in another.
- A play that reads copy, or two behaviours in one play.
