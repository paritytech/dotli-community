# `@config/storybook`

Shared Storybook and browser-test configuration for the UI packages. Internal, workspace-only.

## Responsibility

- The Storybook main config and the Vitest browser config that run stories in a real Chromium.
- Not owned: stories, fixtures and frames. They live in each package beside its components.

## Design

- Each package calls `storybookMain()` from its Storybook config. Stories sit beside their components. Addons are docs,
  a11y and vitest.
- `storybook-solidjs-vite` adds the Solid plugin, so the config adds none. CSS modules come from the shared Vite
  tooling. `VITE_NETWORKS` is defined for stories.
- Each package calls `storybookVitestConfig(packageDir)` from a Vitest config of its own for stories. It stays apart
  from the package's unit test config, so `npm test` needs no browser.
- The shared test setup raises the async test timeout for lazy chunks. With `VRT=1` it screenshots each passing story
  into a machine-local folder, which is never committed.

## Entries

| Entry                      | Use                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@config/storybook/main`   | `storybookMain({ plugins?, viteConfigPath? })` returns the Storybook config. `plugins` runs per build. |
| `@config/storybook/vitest` | `storybookVitestConfig(packageDir)` returns the browser test config for the package's stories.         |
