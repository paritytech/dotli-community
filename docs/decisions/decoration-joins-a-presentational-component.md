# An optional decoration joins a presentational component

A developer adds an optional decoration, such as a small badge, to a presentational piece of UI, such as a brand logo.
Callers pass the piece a `class` and a test id to size and place it. The piece may render a single root element, such
as an inline SVG, and the decoration needs a positioned wrapper around it. Or the piece may appear in several forms
built from the same parts, such as a symbol alone or a symbol beside a word, where each part is its own component that
callers place side by side, and where the decoration sits depends on the form: at the end of the word in one form, on
the symbol in another. The questions are whether the decoration becomes a flag on one part or the whole piece becomes
one component, whether the wrapper appears only when the flag is set, and where the caller's `class` and test id go.

## How to resolve

1. When the piece has several forms that callers assemble from parts, make one component for the whole piece that
   renders every form, and let the caller pick the form with a `variant` prop. Move the callers that assembled the parts
   to it.
2. Give each optional decoration its own boolean prop, named for the decoration.
3. Let the component decide where each decoration sits in each form. A caller never places one.
4. Always render the positioned wrapper, with or without the flag, so the component's root element never depends on a
   flag.
5. Move the caller's `class` and test id to the wrapper. Give the wrapper a width that fits its content, and let the
   inner element fill it. Each caller's CSS that sized the inner element now sizes the wrapper.

The owner's reason: a decoration on one part lands where that part is, not where the whole piece needs it, so one
component that knows every form places it right. The owner chose the permanent wrapper without stating a reason. It
keeps one root for every caller, so a flag never changes what the caller's `class` and test id land on.

## Example

```tsx
// One component, the form picked by `variant`, each decoration a boolean.
<Emblem variant="symbol" />
<Emblem variant="full" ribbon class={s['brand']} testId="brand" />
```

```tsx
// Inside, the wrapper is always the root and carries what the caller passes, and each form places the decoration.
<span class={`${s['frame']} ${props.class ?? ''}`} data-testid={props.testId}>
  <EmblemGlyph />
  <Show when={props.variant === 'full'}>
    <EmblemWord />
  </Show>
  <Show when={props.ribbon}>
    <span class={s['ribbon']} data-variant={props.variant}>new</span>
  </Show>
</span>
```

```css
.frame {
  position: relative;
  display: inline-block;
  width: fit-content;
}
```

Not this, where callers assemble the parts and the decoration hangs on one of them, or the root changes with the flag:

```tsx
<EmblemGlyph ribbon />
<EmblemWord />

props.ribbon ? <span class={s['frame']}><svg class={props.class} />…</span> : <svg class={props.class} />
<Emblem ribbon frameClass={s['brand-frame']} class={s['brand']} />
```

## Cases

- A brand symbol gained a flag that pins a Beta tag to its corner. The wrapper became its permanent root, sized to fit
  its content, and took the callers' `class` and test id. (PR #493, branch `feat/landing-horizon`, design
  `docs/_plans/beta-logo-flag-design.md`)
- The brand logo was then still a symbol component and a wordmark component that callers placed side by side, and the
  Beta badge, a flag on the symbol, sat on its corner while the reference showed it at the end of the word. The
  owner asked for one logo component with a `variant` prop for symbol alone or with the word, and a `beta` boolean. The
  always-present wrapper stays its root. (PR #493, branch `feat/landing-horizon`, design
  `docs/_plans/beta-logo-flag-design.md`)

Status: active
