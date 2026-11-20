# A story's contrast check fails on a decorative background graphic

A developer works on a decorative background graphic that is hidden from assistive technology with `aria-hidden`, and
that carries small text, such as labels, over a dark surface. Its stories run the a11y addon's axe check. After a change
to the graphic's markup or CSS, axe's `color-contrast` rule reports a failure on that text, often because it now reads
another part of the graphic as the text's background. The question is whether to turn the contrast rule off, keep it on
and hide the graphic from axe, or reshape the markup until axe passes again.

## How to resolve

1. Confirm the graphic is decorative and hidden from assistive technology.
2. Turn off the `color-contrast` rule in the a11y config of the graphic's story file meta, so every story of the file
   inherits it.
3. Leave the other axe rules on.
4. Give the setting a one-line reason: contrast is unnecessary for a background graphic.
5. Keep the change to the graphic that made axe fail, rather than reworking it so axe passes or returns "incomplete"
   again.

The owner's reason: contrast is unnecessary for background graphics, so the rule only reports noise on them.

## Example

```tsx
// Before: the markup keeps extra wrappers only so axe returns "incomplete" on the labels.
const meta = {
  title: 'Landing/Backdrop',
  component: Backdrop,
} satisfies Meta<typeof Backdrop>;

// After: the backdrop's stories turn off the contrast rule with its reason.
const meta = {
  title: 'Landing/Backdrop',
  component: Backdrop,
  parameters: {
    // Contrast is unnecessary for background graphics: the backdrop is decorative and hidden from assistive technology.
    a11y: { config: { rules: [{ id: 'color-contrast', enabled: false }] } },
  },
} satisfies Meta<typeof Backdrop>;
```

## Cases

- The landing page's orbit, a decorative `aria-hidden` backdrop, labels its peers in small text over a dark surface. A
  fix for a WebKit 3D bug removed its ring wrappers' boxes, and axe then read the rotated links' bounding boxes as the
  labels' background and failed contrast, where before it returned "incomplete". The owner chose to turn
  `color-contrast` off in the orbit's stories with a comment that contrast is unnecessary for background graphics,
  over excluding the graphic from axe's context or keeping the wrappers. (branch `feat/landing-orbit-peers`, commit
  80169989b, `docs/_plans/landing-orbit-peers-design.md`)

Status: active
