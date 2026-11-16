# Files sit away from the feature they serve

The code is grouped by feature, but some files that serve a single feature still sit in a top-level folder filed by
kind, such as functional and end-to-end tests under `tests/`.

## How to resolve

1. Move each file that serves one feature into that feature's folder. Tests go under its `__tests__/`, one folder per
   kind of test.
2. Put what spans several features in the folder that composes them, such as the shell.
3. Keep in the central folder only what several features share, such as suite configs and fixtures.

The owner's reason: it is much simpler.

## Example

```text
src/features/checkout/
  cart.ts
  cart.spec.ts                 unit spec beside its module
  __tests__/
    functional/
      cartFlow.spec.ts
    e2e/
      checkout.spec.ts
src/shell/__tests__/           specs that span several features
tests/                         only what several features share
  playwright.config.ts
  globalSetup.ts
  fixtures/
```

Not this:

```text
tests/
  functional/cartFlow.spec.ts
  e2e/checkout.spec.ts
```

## Cases

- Each feature's functional and end-to-end tests moved into the feature folder, under `__tests__/functional/` and
  `__tests__/e2e/`. The suite configs, fixtures and helpers stayed in the app's `tests/`. (PR #479)

Status: active
