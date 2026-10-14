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
- The config adds one shared preview to every Storybook: dark docs, a11y failures as errors, the two viewports and a
  render that hands a component its args. Its canvas render commits a story's args before the story renders, since the
  framework writes them and renders in one go and the first effects would read an empty store. A page frame sets each
  story on the dotli page, unless the package turns it off because it draws its own page. A package's own preview adds
  its stylesheet and what only it needs.
- Each package calls `storybookVitestConfig(packageDir)` from a Vitest config of its own for stories. It stays apart
  from the package's unit test config, so `npm test` needs no browser. It allows the test server's write and exec calls,
  which the Storybook plugin turns off unless set, since a tap goes through the DevTools protocol.
- The shared test setup raises the async test timeout for lazy chunks. With `VRT=1` it screenshots each passing story
  into a machine-local folder, which is never committed.

## Entries

| Entry                      | Use                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@config/storybook/main`   | `storybookMain({ plugins?, viteConfigPath?, pageFrame? })` returns the Storybook config. `plugins` runs per build. |
| `@config/storybook/vitest` | `storybookVitestConfig(packageDir)` returns the browser test config for the package's stories.                     |
| `@config/storybook/play`   | `trustedInput()` loads the trusted user input a play needs, on demand.                                             |
