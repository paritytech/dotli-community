# `@config/storybook`

## Overview

Tooling for the one Storybook at the repo root. Internal.

## Responsibilities

- **Owns:**
  - the shared preview
  - the page frame
  - the browser test config and setup
  - play helpers
- **Does not own:** the Storybook config at the repo root, or stories and fixtures, which live beside their components.

## Public API

| Entry                          | Use                                                                  |
| ------------------------------ | -------------------------------------------------------------------- |
| `@config/storybook/preview`    | The preview every story gets.                                        |
| `@config/storybook/page-frame` | The decorator that sets a story on the dotli page.                   |
| `@config/storybook/vitest`     | `storiesBrowserTest`, the Vitest config for stories.                 |
| `@config/storybook/play`       | `trustedInput()` for user input, `expectBefore()` for reading order. |

## Design

- **Preview:** dark docs and two viewports. An a11y failure is an error. It commits a story's args before render, so
  first effects see them.
- **Page frame:** sets each story on the dotli page. A story that draws its own page sets `parameters.pageFrame` to
  `false`.
- **Browser tests:** kept apart from unit test configs, so `npm test` needs no browser. Stories run in Chromium.
- **Visual snapshots:** with `VRT=1`, each passing story is screenshot to a machine-local folder that is never
  committed.
