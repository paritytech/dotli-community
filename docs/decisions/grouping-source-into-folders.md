# Grouping source into folders

An app's source is grouped or regrouped into folders, and the question is how much structure it gets. A level, an
`index.ts`, a lint boundary or a set of subfolders each look useful on their own.

## How to resolve

1. Add a folder level only where it separates something real. An app with user flows gets a `features/` level that
   keeps the flows apart from the rest, such as pages and shared helpers. An app with none keeps its folders straight in
   `src/`.
2. Keep a folder flat while it is small, with specs beside their modules.
3. Past about 30 source files, split it into subfolders named for what the code does. Never split by file kind, such as
   `ui/` or `state/`.
4. Give a folder an `index.ts` and a lint boundary when other folders depend on it as a whole, as on a feature. A small
   app whose folders have a few cycles, each resting on one import, gets neither
   ([an import cycle between folders](import-cycle-between-folders.md)).

The owner chose these without stating a reason. Together they add structure only where it pays, and keep the parts of
one purpose side by side.

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
    payments/            past about 30 files, split by what the code does
      cards/
      refunds/
      index.ts
  pages/
  shell/
  kit/
```

An app with no user flows:

```text
src/
  transport/             no index.ts, no boundary
  storage/
  main.ts                composes them
```

Not this, folders by file kind:

```text
features/payments/
  ui/
  state/
  utils/
```

## Cases

- The host app, which has user flows, got a `features/` level. The sandbox and protocol apps, which have none, kept
  their folders straight in `src/`. (PR #479)
- Feature folders stay flat and split by sub-flow past about 30 source files. (PR #479)
- The two small apps with no user flows got no `index.ts` files and no boundaries. (PR #479)

Status: active
