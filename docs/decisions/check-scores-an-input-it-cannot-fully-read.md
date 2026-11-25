# A check scores an input it cannot fully read

A developer is building a check that scores a measured value, such as the contrast of text against what paints behind
it. They find a case where one input the score needs is not fully knowable, such as what shows through a translucent
layer that blurs whatever lies beneath it. Giving up whenever anything is unknown would be faithful, but it would take the
verdict away from most real cases. The question is when the check gives up and when it still scores.

## How to resolve

1. Ask how far the unknown can move the score. When nothing caps it, such as an effect on the scored element or its
   ancestors that can lighten, darken or invert it at will, give up and return no verdict.
2. When something caps it, such as a layer's own opacity limiting how much of what lies beneath can show through, score
   the extremes the cap allows, such as opaque black and opaque white beneath, and keep the worst.
3. When the reference tool the check follows also ignores an effect, such as a fade mask, ignore it too and write it
   down as a known limit in the check's docs.

The owner chose this without stating a reason beyond the option itself: giving up on every unknown is faithful but sends
most verdicts back to unknown, while scoring the worst extreme keeps a verdict wherever the unknown is bounded.

## Example

```ts
function backgroundsFor(layer: LayerSnapshot): Color[] | null {
  // Unbounded: an effect on the element or its ancestors can move the score anywhere.
  if (layer.filter !== 'none') return null;
  // Bounded: the layer's own alpha caps what shows through, so score both extremes.
  if (layer.backdropFilter !== 'none') {
    return [blend(layer.color, BLACK), blend(layer.color, WHITE)];
  }
  // The reference tool ignores a fade mask too. Listed as a known limit in the README.
  return [layer.color];
}

// The caller scores each background and keeps the worst.
const score = Math.min(...backgrounds.map(background => toneRatio(text, background)));
```

Not this:

```ts
// Strict: any effect at all ends in no verdict, so most real layers are never scored.
if (layer.filter !== 'none' || layer.backdropFilter !== 'none' || layer.maskImage !== 'none') return null;
```

Related: [public-api-misses-a-dev-only-path](public-api-misses-a-dev-only-path.md) and
[tooling-package-extends-storybook](tooling-package-extends-storybook.md) cover how such a check plugs into the tool
that runs it.

## Cases

- The APCA contrast rule for the Storybook a11y check walked a gradient background and scored layers painted through a
  filter, a backdrop filter or a mask as if those were absent. The owner chose to give up on a filter on the scored
  element or its ancestors, to score the opaque black and white extremes beneath a translucent, backdrop-filtered layer
  and keep the worst, and to leave a fade mask ignored as axe does, written down in the docs.
  (docs/_plans/apca-contrast-design.md, docs/_reviews/apca-contrast-review.md finding GR1)

Status: active
