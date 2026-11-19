# An optional overlay needs a wrapper around a component's root

A shared presentational component renders a single root element, such as an inline SVG. Callers pass it a `class` and a
test id to size and place it. The component gains an optional flag that pins a small overlay, such as a badge, to a
corner of that element, and the overlay needs a positioned wrapper around it. The question is whether the wrapper
appears only when the flag is set, and where the caller's `class` and test id go once it exists.

## How to resolve

1. Always render the wrapper, with or without the flag, so the component's root element never depends on a flag.
2. Move the caller's `class` and test id to the wrapper.
3. Give the wrapper a width that fits its content, and let the inner element fill it.
4. Let each caller's CSS that sized the inner element now size the wrapper.

The owner chose this without stating a reason. It keeps one root for every caller, so a flag never changes what the
caller's `class` and test id land on.

## Example

```tsx
// The wrapper is always there and carries what the caller passes.
<span class={`${s['frame']} ${props.class ?? ''}`} data-testid={props.testId}>
  <svg class={s['mark']} viewBox="0 0 24 24">…</svg>
  <Show when={props.stamp}>
    <span class={s['stamp']}>new</span>
  </Show>
</span>
```

```css
.frame {
  position: relative;
  display: inline-block;
  width: fit-content;
}
.mark {
  display: block;
  width: 100%;
  height: 100%;
}
```

Not this, where the root changes with the flag, or a second prop styles the wrapper:

```tsx
props.stamp ? <span class={s['frame']}><svg class={props.class} />…</span> : <svg class={props.class} />
<Seal stamp frameClass={s['seal-frame']} class={s['seal']} />
```

## Cases

- A brand symbol gained a flag that pins a Beta tag to its corner. The wrapper became its permanent root, sized to fit
  its content, and took the callers' `class` and test id. (PR #493, branch `feat/landing-horizon`, design
  `docs/_plans/beta-logo-flag-design.md`)

Status: active
