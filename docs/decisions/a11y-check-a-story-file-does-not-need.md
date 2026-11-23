# An a11y check a story file does not need

A story file's stories run as browser tests, and the shared Storybook preview runs the a11y addon's axe check after each
one. A developer notices the check costing time or failing on stories where what it checks has nothing to find:

- the file drives a component at full capacity, such as thousands of rows in the DOM, and axe over the large DOM takes
  most of each story's time, pushing the heaviest stories near the browser test timeout or past it on CI. The
  component's accessibility is already checked by its stories at a normal size.
- the file shows a decorative background graphic hidden from assistive technology with `aria-hidden`, with small text
  over a dark surface, and after a change to its markup or CSS axe's `color-contrast` rule fails on that text, often
  because it now reads another part of the graphic as the text's background.

The question is which of these to do:

- raise the timeout
- shrink what the stories exercise
- rework the markup until axe passes
- turn the check off

## How to resolve

1. Confirm what the check would cover is covered elsewhere or does not apply: the component's normal-size stories still
   run the a11y check, or the graphic is decorative and hidden from assistive technology.
2. Turn off only what has nothing to find, in the story file's meta parameters, so every story of the file inherits it.
   That is the a11y test for a capacity file, or the one rule, such as `color-contrast`, for a decorative graphic. Never
   in the shared preview, and never story by story.
3. Keep the other a11y parameters and rules the file inherits.
4. Give the setting a one-line reason, such as that these stories exercise capacity and the normal-size stories check
   accessibility, or that contrast is unnecessary for a background graphic.
5. Leave the timeout, the capacity the stories exercise and the change that made axe fail as they are. Do not rework the
   markup so axe passes or returns "incomplete" again.

The owner's reason: the capacity stories exist to check behaviour at capacity, and their accessibility is already
checked at a normal size, so axe over the large DOM only costs time. Contrast is unnecessary for background graphics, so
the rule only reports noise on them.

## Example

```tsx
// A capacity file opts out of the axe test with its reason.
const meta = {
  title: 'Widgets/Feed at capacity',
  parameters: {
    ...feedStory.parameters,
    // These stories exercise the feed at capacity. Its accessibility is checked by its normal-size stories.
    a11y: { ...feedStory.parameters['a11y'], test: 'off' },
  },
} satisfies Meta;

// A decorative backdrop turns off the one rule with nothing to find.
const meta = {
  title: 'Landing/Backdrop',
  component: Backdrop,
  parameters: {
    // Contrast is unnecessary for background graphics: the backdrop is decorative and hidden from assistive technology.
    a11y: { config: { rules: [{ id: 'color-contrast', enabled: false }] } },
  },
} satisfies Meta<typeof Backdrop>;
```

Not this: a raised timeout or a cut row count to make room for axe. Nor extra wrappers kept in the markup only so axe
returns "incomplete".

## Not when

- The check reports a real problem on an interactive part, such as `nested-interactive` on a control inside a listbox
  option. Fix the markup instead, as
  [listbox-option-needs-a-remove-action](listbox-option-needs-a-remove-action.md) says.

## Cases

- A debug panel's story file counted work at capacity over about 2000 rows. Axe was about 60% of each story's time, and
  one story timed out on CI on main. The a11y test was turned off in that file's meta with a one-line reason, instead of
  raising the timeout or shrinking the capacity. (main session fixing flaky Storybook tests after PR #490, uncommitted on
  main)
- The landing page's orbit, a decorative `aria-hidden` backdrop, labels its peers in small text over a dark surface. A
  fix for a WebKit 3D bug removed its ring wrappers' boxes, and axe then read the rotated links' bounding boxes as the
  labels' background and failed contrast, where before it returned "incomplete". The owner chose to turn
  `color-contrast` off in the orbit's stories with a comment that contrast is unnecessary for background graphics,
  over excluding the graphic from axe's context or keeping the wrappers. (branch `feat/landing-orbit-peers`, commit
  80169989b, `docs/_plans/landing-orbit-peers-design.md`)

Status: active
