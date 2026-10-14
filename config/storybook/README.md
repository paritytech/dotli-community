# `@config/storybook`

The Storybook tooling for the one Storybook at the repo root. Internal, workspace-only.

## Responsibility

- The preview every story gets, the page frame, the browser test config that runs stories in a real Chromium, its test
  setup and the helpers story plays share.
- Not owned: the Storybook's own config, which lives at the repo root and picks up every story. Stories, fixtures and
  frames live in each package beside its components.

## Design

- The root Storybook config adds the preview and the page frame as preview annotations, before its own preview, which
  adds the stylesheet and the sidebar order.
- The preview: dark docs, a11y failures as errors, the two viewports and a render that hands a component its args. Its
  canvas render commits a story's args before the story renders, since the framework writes them and renders in one go
  and the first effects would read an empty store.
- The page frame sets each story on the dotli page. A story that draws its own page, such as the debug panel's, sets
  `parameters.pageFrame` to `false`. The frame undoes its page background on unmount, so the next story in the same
  preview starts clean.
- The browser test config stays apart from the unit test configs, so `npm test` needs no browser. The root Vitest config
  for stories adds the Storybook plugin to it. It allows the test server's write and exec calls, which the Storybook
  plugin turns off unless set, since a tap goes through the DevTools protocol.
- The test setup raises the async test timeout for lazy chunks. With `VRT=1` it screenshots each passing story into a
  machine-local folder keyed on the story file's path, which is never committed.

## Entries

| Entry                          | Use                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `@config/storybook/preview`    | The preview every story gets. A preview annotation.                                                           |
| `@config/storybook/page-frame` | The decorator that sets a story on the dotli page, unless `parameters.pageFrame` is `false`.                  |
| `@config/storybook/vitest`     | `storiesBrowserTest`, the Vitest config that runs stories in Chromium, for the Storybook plugin to extend.    |
| `@config/storybook/play`       | `trustedInput()` loads the trusted user input a play needs, on demand. `expectBefore()` checks reading order. |
