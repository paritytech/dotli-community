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

## Cases

- Asked to add a Beta badge to a header logo like the toolbar shows it, the slice pinned the badge to the symbol's
  corner, where the toolbar shows it at the end of the word, and presented it unchecked. The owner rejected it. (PR #493,
  branch `feat/landing-horizon`, design `docs/_plans/beta-logo-flag-design.md`)

Status: active
