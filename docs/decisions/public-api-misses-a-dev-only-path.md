# A third-party tool's public API misses a dev-only path

A developer is plugging custom behaviour, such as a custom check, into a third-party tool. They notice that the tool's
public API carries it on the paths that matter, such as tests and automatic runs, but one dev-only path loses it, such as
a manual or hot-reload rerun in the tool's dev UI that receives the settings through a channel that drops functions.
The tool's internals, such as a registry in a namespace the tool marks for deletion, would let it reach every path. The
question is whether to use the internals to close the gap or keep to the public API and accept it.

## How to resolve

1. Confirm the public API serves the tests and the automatic runs in full.
2. Confirm the gap hits only the dev-only path and shows itself there, such as a rule reported as incomplete with an
   error until the view reloads, rather than passing quietly.
3. Use the public API only. Do not register anything in the tool's internals to cover the dev-only path.

The owner chose the public API without stating a reason beyond the option itself: the internal route works on every path
but a tool upgrade may break it.

## Example

```ts
// Public API: the settings carry the check function. A dev-UI rerun drops it and shows the rule as incomplete.
const parameters = {
  audit: { config: { checks: [{ id: 'tone-ratio', evaluate: toneRatioCheck }] } },
};
```

Not this:

```ts
// Internal registry the tool marks for deletion, so the settings can name the check by a string id.
auditor._internals.checkRegistry['tone-ratio'] = toneRatioCheck;
const parameters = {
  audit: { config: { checks: [{ id: 'tone-ratio', evaluate: 'tone-ratio' }] } },
};
```

Related: [build-feature-the-framework-lacks](build-feature-the-framework-lacks.md) builds custom build code only on the
framework's own hooks, never its internals.

## Cases

- A custom contrast rule for the Storybook a11y check passes its check function in the a11y settings. Tests and
  automatic runs work, and a rerun from Storybook's dev UI, whose message channel drops functions, reports that rule as
  incomplete until the view reloads. The owner chose this over registering the function in axe's internal
  id-to-function map. (docs/_plans/apca-contrast-design.md)

Status: active
