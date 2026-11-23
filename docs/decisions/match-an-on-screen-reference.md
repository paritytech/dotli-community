# A change must look like something already on screen

The owner asks for a piece of UI to be done like an existing one, such as a label shown the way another header shows
it. The developer builds it and is about to present the slice. The question is whether a close version, or one the
design moved for its own convenience, is enough.

## How to resolve

1. Find the reference on screen and note where each element sits in it.
2. Place each element exactly where the reference shows it.
3. Open the result in a browser beside the reference and compare them.
4. Present the work only once it matches. Fix a difference before presenting, never after.

The owner's reason: asked to do it like the reference, the owner expects it to look like the reference, and expects the
developer to check their own work before showing it.

## Example

```text
reference header:  [glyph] wordmark(new)
built header:      [glyph(new)] wordmark    <- differs, fix before presenting
built header:      [glyph] wordmark(new)    <- matches, present
```

The bound, where a shared component places the decoration itself at fixed offsets:

```text
reference at the large size:  wordmark (new)   <- 2px further out
shared component, fixed:      wordmark(new)    <- accept, keep the fixed offsets
not: a ratio rule inside the component, an offset prop or custom property, or a caller override
```

## Not when

A shared component places the element itself at fixed offsets, and the reference differs from that placement by a
pixel or two only at the size one caller shows the component. Keep the component's fixed offsets and accept the small
shift. Do not make the component compute its offsets from its own size, expose the offset for the caller to set, or let
the caller override the position to close the gap. The owner chose this without stating a reason.

A shared surface that opens from a trigger moves onto placement against its trigger, and its old look came from the
app's own CSS lining it up with an enclosing bar's edge. It sits against the trigger's own edge, a few pixels from the
old look, as [a surface is placed against its trigger](surface-placed-against-its-trigger.md) says.

## Cases

- Asked to add a Beta badge to a header logo like the toolbar shows it, the slice pinned the badge to the symbol's
  corner, where the toolbar shows it at the end of the word, and presented it unchecked. The owner rejected it. (PR #493,
  branch `feat/landing-horizon`, design `docs/_plans/beta-logo-flag-design.md`)
- In the same change, the one logo component pinned the badge at fixed offsets, and at one caller's larger size the old
  screen put it 2px further out vertically and under 1px horizontally. Offered a ratio rule in the component, a custom
  property the caller sets, or a caller override, the owner accepted the shift. (PR #493, branch `feat/landing-horizon`,
  design `docs/_plans/beta-logo-flag-design.md`)
- Counter-case: a tooltip card that dropped from a bar's bottom edge through the app's CSS moved onto the shared
  floating layer and now sits against its trigger's bottom edge, a few pixels higher.
  (docs/\_plans/floating-placement-design.md, feat/floating-ui)

Status: active
