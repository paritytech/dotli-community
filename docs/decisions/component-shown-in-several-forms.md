# A component shown in several forms that callers assemble from parts

A developer works on a presentational piece of UI, such as a brand logo, that appears in several forms built from the
same parts, such as a symbol alone or a symbol beside a word. Each part is its own component, and each caller places the
parts side by side to form the whole. Now an optional decoration, such as a small badge, has to join, and where it sits
depends on the form: at the end of the word in one form, on the symbol in another. The question is whether the
decoration becomes a flag on one part, or the whole piece becomes one component.

## How to resolve

1. Make one component for the whole piece, which renders every form.
2. Let the caller pick the form with a `variant` prop.
3. Give each optional decoration its own boolean prop, named for the decoration.
4. Let the component decide where each decoration sits in each form. A caller never places one.
5. Move the callers that assembled the parts to the one component.

The owner's reason: a decoration on one part lands where that part is, not where the whole piece needs it, so one
component that knows every form places it right.

## Example

```tsx
// One component, the form picked by `variant`, each decoration a boolean.
<Emblem variant="symbol" />
<Emblem variant="full" ribbon />
```

```tsx
// Inside, each form places the decoration itself.
<span class={`${s['frame']} ${props.class ?? ''}`}>
  <EmblemGlyph />
  <Show when={props.variant === 'full'}>
    <EmblemWord />
  </Show>
  <Show when={props.ribbon}>
    <span class={s['ribbon']} data-variant={props.variant}>new</span>
  </Show>
</span>
```

Not this, where callers assemble the parts and the decoration hangs on one of them:

```tsx
<EmblemGlyph ribbon />
<EmblemWord />
```

## Cases

- The brand logo was a symbol component and a wordmark component that callers placed side by side, and a Beta badge
  became a flag on the symbol, pinned to its corner, while the reference showed it at the end of the word. The owner
  asked for one logo component with a `variant` prop for symbol alone or with the word, and a `beta` boolean. The
  always-present wrapper of [optional-overlay-needs-a-wrapper](optional-overlay-needs-a-wrapper.md) stays its root.
  (PR #493, branch `feat/landing-horizon`, design `docs/_plans/beta-logo-flag-design.md`)

Status: active
