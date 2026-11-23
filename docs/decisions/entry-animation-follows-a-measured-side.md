# An entry animation follows a side known only after measuring

A developer animates a shared surface's entry, such as a slide and a fade, in the direction of the side it opens on.
That side is known only once the shown surface is measured, so the entry has already started from the side the surface
took last time. The first entry on a new side slides the other way for a few pixels, while the origin and the exit are
right. The question is whether to fix it with keyframes that read the side, by restarting the transition before first
paint, or by dropping the slide.

## How to resolve

1. Let the entry, the origin and the exit read the side the way they already do.
2. Accept the few pixels of the wrong direction on the first entry on a new side.
3. Add no keyframes that read the side, no restart of the transition before first paint, and do not drop the slide to
   hide the glitch.

The owner chose to accept it, with no code, without stating a reason.

## Example

```css
/* The entry reads the side the surface took. Kept as is. */
.card {
  transition:
    opacity 120ms,
    translate 120ms;
}
.card[data-side='top']:not(:popover-open) {
  translate: 0 4px;
}
.card[data-side='bottom']:not(:popover-open) {
  translate: 0 -4px;
}
```

Not this:

```ts
// Restarting the entry once the side is known.
card.style.transition = 'none';
card.dataset['side'] = side;
void card.offsetHeight;
card.style.transition = '';
```

## Cases

- Surfaces on a shared floating layer took their side after the shown surface was measured, so the first opening on a
  new side slid a few pixels the other way. Offered keyframes reading the side variable, a transition restart before
  first paint, or fade and scale with no slide, the owner accepted the glitch with no code.
  (docs/\_plans/floating-placement-design.md, feat/floating-ui)

Status: active
