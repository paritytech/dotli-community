# Designs compete, and the elaborate ones guard a measurable cost

There is a simple way to build something and more elaborate ones. The elaborate ones exist to protect something a probe
or a measurement can show, such as the size of the eager bundle, a test setup only some files need, or what a cold first
visit costs, such as a late asset or a layout shift.

## How to resolve

1. Build the simplest design first.
2. Measure it against what the elaborate designs protect, or run a probe that shows whether that protection is needed.
3. Show the owner the numbers.
4. Keep the simple design when the numbers hold, and drop the machinery the probe shows is not needed. A small cost the
   numbers show can still hold, such as a short swap on a first visit that repeat visits never pay, or a few kB a
   library adds to every bundle that loads at boot when a lazy chunk with an idle preload would keep it out. The owner
   judges it.

The owner's reason: the owner asks for the simplest form, and keeps it once a measurement backs it.

## Example

The elaborate design keeps a loader module per feature to protect the eager bundle:

```ts
// features/payments/lazy.ts, re-exported from features/payments/index.ts
export const loadRefunds = () => import('./refunds/RefundsView.js');
```

The simple design writes the `import()` where it is needed:

```ts
// features/orders/OrderActions.tsx
const { RefundsView } = await import('../payments/refunds/RefundsView.js');
```

Build the simple one, compare the eager bundle size on both, and keep the simple one when it is no larger.

## Not when

- The guarding piece is already built, the change's design names it, and a cleanup would drop it to save a few lines.
  That is not a choice between designs while building, so it is not measured first. Keep it, as
  [cleanup-rewrite-that-reads-no-better](cleanup-rewrite-that-reads-no-better.md) says.

## Cases

- Per-feature loader modules gave way to an `import()` written at each call site. The eager pages came out smaller, and
  the owner kept it. (PR #479)
- Per-folder test projects merged into one, once a probe showed every unit spec passing with every setup. (PR #479)
- Brand webfonts load through one shared stylesheet that imports the font package's own `@font-face` CSS, bundled alike
  in every build. Measured on a cold, throttled first visit, the font came a little after first paint with a tiny swap
  shift on one page, and the owner kept the simple import over the framework's font feature with preload and fallback
  faces in one build. (docs/_plans/brand-fonts-design.md, PR #493)
- A shared floating layer that islands hydrating on load import statically took a positioning library by a static
  import, about 6 kB compressed on every bundle with a floating surface. The owner chose it over a lazy chunk loaded on
  first opening and preloaded when idle, which kept boot unchanged but added a loader, an idle preload, a layer hidden
  until placed and a possible wait on an early first opening. (docs/\_plans/floating-placement-design.md, feat/floating-ui)
- Counter-case: a cleanup proposed dropping a built gate, named in the design, that keeps an open panel's clock idle
  when nothing is in use. The owner kept it over dropping it or measuring idle CPU first. (feat/network-chain-indicators)

Status: active
