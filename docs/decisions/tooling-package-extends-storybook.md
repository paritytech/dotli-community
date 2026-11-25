# A tooling package extends the Storybook

A developer is writing a local tooling package that adds behaviour to the repo's one Storybook, such as a custom rule
that an existing addon runs. The first shape that comes to mind is a package that exports settings and names. The shared
preview imports the settings into its parameters, and a story that refers to something the package defines, such as a
rule it turns off, imports that name from the package so the two never drift. The question is how the Storybook takes
the package in, and where else it may be imported.

## How to resolve

1. Make the package a Storybook addon. Its own preview entry sets everything it adds to the Storybook, such as
   parameters or decorators.
2. Name it in one place only: the `addons` list of the Storybook config.
3. Import it nowhere else. The shared preview does not import it, and no story or other package does.
4. A story that refers to something the addon defines, such as a rule id, names it as a plain string, the same way it
   names the built-in ids of the addon it extends.

The owner said the package should be a Storybook plugin, imported in one place, the Storybook config. This takes
precedence over sharing the id through an import, which AGENTS.md otherwise asks of two values that must stay in sync.

## Example

```ts
// tooling/tone-check/src/preview.ts, the addon's own preview entry
export const parameters = {
  audit: { config: { rules: [toneRule], checks: [toneCheck] } },
};

// the Storybook config
const config = {
  addons: ['@addon/audit', '@tooling/tone-check'],
} satisfies StorybookConfig;

// a story file opts out by the id as a string
parameters: { audit: { options: { rules: { 'tone-ratio': { enabled: false } } } } },
```

Not this:

```ts
// the shared preview
import { toneSettings } from '@tooling/tone-check';
export const parameters = { audit: { config: toneSettings } };

// a story file
import { TONE_RULE_ID } from '@tooling/tone-check';
parameters: { audit: { options: { rules: { [TONE_RULE_ID]: { enabled: false } } } } },
```

Related: [public-api-misses-a-dev-only-path](public-api-misses-a-dev-only-path.md) covers how such a package passes its
check to the tool it plugs into.

## Cases

- A local package adding an APCA text contrast rule to the a11y addon first exported a settings object the shared
  preview imported and a rule id stories imported to opt out. The owner steered it into a Storybook addon named once in
  the Storybook config's `addons` list, with stories naming the rule id as a string. (docs/_plans/apca-contrast-design.md,
  replacing commit 01d1b1652)

Status: active
