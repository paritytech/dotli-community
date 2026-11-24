# Grouping source into folders

An app's source is grouped or regrouped into folders, and the question is how much structure it gets. A level, an
`index.ts`, a lint boundary or a set of subfolders each look useful on their own. Or the code is already grouped by
feature, but some files that serve a single feature still sit in a top-level folder filed by kind, such as functional
and end-to-end tests under `tests/`. Or a change moves the only caller of a helper from one feature into another, and the
helper still sits in the old feature's folder.

## How to resolve

1. Add a folder level only where it separates something real. An app with user flows gets a `features/` level that
   keeps the flows apart from the rest, such as pages and shared helpers. An app with none keeps its folders straight in
   `src/`.
2. Keep a folder flat while it is small, with specs beside their modules.
3. Past about 30 source files, split it into subfolders named for what the code does. Never split by file kind, such as
   `ui/` or `state/`.
4. Move each file that serves one feature into that feature's folder, wherever it sat by kind. Tests that do not sit
   beside a module go under the feature's `__tests__/`, one folder per kind of test. A helper whose only caller moves to
   another feature moves with it, into the caller's feature. Do not file it under a feature whose types it uses, and do
   not leave it in its old feature exported for the caller. When its new feature already holds part of what it reads,
   trim it as [a moved helper reads what its new home holds](moved-helper-reads-what-its-new-home-holds.md) says.
5. Put what spans several features in the folder that composes them, such as the shell. Keep in a central folder only
   what several features share, such as suite configs and fixtures.
6. Give a folder an `index.ts` and a lint boundary when other folders depend on it as a whole, as on a feature. A small
   app whose folders have a few cycles, each resting on one import, gets neither
   ([an import cycle between folders](import-cycle-between-folders.md)).

The owner's reason for moving a feature's files into its folder: it is much simpler. The owner chose the other steps,
and moving a helper with its only caller, without stating a reason. Together they add structure only where it pays, and keep the parts of one purpose side by
side.

## Example

An app with user flows:

```text
src/
  features/
    checkout/            small, so flat, specs beside their modules
      CartView.tsx
      cart.ts
      cart.spec.ts
      index.ts
      __tests__/
        functional/cartFlow.spec.ts
        e2e/checkout.spec.ts
    payments/            past about 30 files, split by what the code does
      cards/
      refunds/
      index.ts
  pages/
  shell/
    __tests__/           specs that span several features
  kit/
tests/                   only what several features share
  playwright.config.ts
  fixtures/
```

An app with no user flows:

```text
src/
  transport/             no index.ts, no boundary
  storage/
  main.ts                composes them
```

A helper whose only caller moved from `orders/` to `invoices/`:

```text
features/
  orders/                  before: receiptImages.ts sat here
  invoices/
    InvoiceView.tsx        its only caller
    receiptImages.ts       moved with the caller
```

Not this, folders by file kind:

```text
features/payments/
  ui/
  state/
  utils/
tests/
  functional/cartFlow.spec.ts
  e2e/checkout.spec.ts
```

## Cases

- The host app, which has user flows, got a `features/` level. The sandbox and protocol apps, which have none, kept
  their folders straight in `src/`. (PR #479)
- Feature folders stay flat and split by sub-flow past about 30 source files. (PR #479)
- The two small apps with no user flows got no `index.ts` files and no boundaries. (PR #479)
- Each feature's functional and end-to-end tests moved into the feature folder, under `__tests__/functional/` and
  `__tests__/e2e/`. The suite configs, fixtures and helpers stayed in the app's `tests/`. (PR #479)
- Chat moved from the product frame to the product worker's run, and the helper that reads chat images moved from the
  product frame's feature into the product worker's feature with its only caller. The owner chose this over filing it
  in the chat feature, whose error and image-read types it uses, or leaving it in its old feature exported for the
  worker. (docs/_plans/worker-chat-design.md)

Status: active
