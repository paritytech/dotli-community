# Stories

What a story file holds, decided before it is written. `docs/code/style.md` § Tests says which test is worth keeping.
This doc says what a story file is for and how its stories are built.

A story file is first the catalogue of one component: each story shows one visible state, reached through its args. A
play is the exception, kept where interaction is the only way to reach a state or is itself the behaviour under test.

## Which components get stories

A component earns stories by what it puts together itself. A story of a component shows what that component adds.

- A component that only fills in another component's props gets no stories. The component it fills already shows every
  look it can take in its own stories, so a story of one filling shows nothing new. A notice built for one case from a
  toast's title, body and icon is such a fill-in. So is one particular button of a toolbar.
- Composed content earns stories, even for one scenario. A modal that brings several parts together for one flow shows
  how they work together, which no story of its parts shows.

## Which states a file shows

Show:

- the default
- each member of a union prop that renders differently
- the empty, loading and error states the component has
- long or overflowing content
- the phone layout, only where it differs from the desktop one

Skip:

- a prop change Controls already shows, unless it changes the look or the behaviour in a way worth naming
- a state that looks the same as another story in the file
- copy variants, such as another label or another name in the same layout

## How stories are built

- Default args sit on `meta`, taken from the fixtures, so a story that shows the default is `{}`.
- A story that differs from another builds on it: `args: { ...Base.args, size: 'lg' }`.
- A frame the component needs to look right, such as the surface or the bar it sits on, is a decorator on `meta`. A
  story has a `render` of its own only when it renders something the meta's does not.
- A parent's stories import a child's story args, so a child's fixture is written once and both files agree on it.
- Args carry the state wherever the component takes it as a prop. A fixture reset in `beforeEach` is for state the
  component reads from a store it is not handed.

## When a story has a play

A play is kept for one of these reasons, named by its clause ID:

- **V**: the state the story shows can only be reached through interaction, such as an open popover.
- **K1**: it documents a public behaviour a user sees and the types do not show, such as a press reported once.
- **K2**: it guards an edge case. Focus that must land or stay, a keyboard path, a close reported once and a race are
  such cases.

A play goes, and its story stays as a visual doc, when it does one of these:

- **C1**: restates the types or a prop passed through unchanged.
- **C2**: pins implementation detail, such as a styling hook or the order of elements.
- **C3**: repeats what another kept story or a unit spec asserts.
- **C4**: tests a constant or a library's own behaviour.

How a kept play is written:

- One behaviour per play. Two behaviours are two stories.
- Find elements by role and accessible name, and by test id only where no role names the element.
- Assert the role or the state a user acts on, never the copy.
- A play that needs heavy setup points at a missing seam. The logic moves into a module with a unit spec, and the play
  keeps only the wiring.

## Before writing

Plan the file as a table before the first story is written. Each row is one state the component can show:

| State | Why it is distinct | Story, play or unit spec | Clause |
| ----- | ------------------ | ------------------------ | ------ |

A row that is not distinct goes before it is written. The `stories` skill runs this plan.
