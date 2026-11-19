# Dim a graphic whose parts overlap

A developer builds a decorative graphic from layered parts that overlap, such as dots that sit on lines or a marker
where several lines meet. The graphic should look faint against the page. Giving each part a translucent colour, a
colour mixed with `transparent` or a gradient that fades to it, makes each part faint, but where parts overlap the one
below shows through the one on top. Working out a faint colour per part, such as blending each one with the page
background, keeps the parts opaque but turns plain colours into a set of computed values. The question is where the
faintness goes.

## How to resolve

1. Make every part opaque, including each stop of a gradient that covers another part.
2. Give each part a plain solid colour token. Never compute a part's colour, such as a `color-mix` with the page
   background or with `transparent`, to make it look faint.
3. Make the whole graphic faint with one `opacity` on the graphic's root, never on the parts inside it.

The owner's reason: a part that lets the parts behind it show through breaks the illusion that it sits on top of them.
Colours should stay solid and simple, and one opacity on the whole block is the simple way to blend it into the page
while the parts keep hiding one another.

## Example

```css
/* not: each part faint on its own, so the line shows through the dot */
.line {
  border-color: color-mix(in srgb, var(--text-strong) 10%, transparent);
}
.dot {
  background: color-mix(in srgb, var(--text-strong) 30%, transparent);
}

/* not: opaque, but every part carries its own computed blend */
.line {
  border-color: color-mix(in srgb, var(--text-strong) 10%, var(--bg-page));
}
.dot {
  background: color-mix(in srgb, var(--text-strong) 30%, var(--bg-page));
}

/* instead: solid tokens on the parts, and one dim on the root */
.line {
  border-color: var(--line-token);
}
.dot {
  background: var(--dot-token);
}
.graphic {
  opacity: 0.8;
}
```

## Cases

- The landing page's orbit backdrop had translucent dots on its orbits and a centre marker with a translucent radial
  gradient, so the orbits showed through both. The owner said translucent dots break the illusion, then, after the
  marker kept its translucency, that dimming belongs on the whole block rather than on the parts inside it.
  (branch `feat/landing-horizon`, PR #493)
- The same orbit was then rebuilt with a different `color-mix` of a text token and the page background on every part.
  The owner called that overcomplicated: the colours should be solid, simple tokens, and the blend comes from a plain
  opacity, such as 0.8, on the orbit's root. (branch `feat/landing-horizon`, PR #493)

Status: active
