# Stories that exercise a component at capacity run near the test timeout

A story file drives a component at its full capacity, such as thousands of rows in the DOM, and its stories run as
browser tests. The shared Storybook preview runs the a11y addon's axe check after every story. A developer notices that
axe over the large DOM takes most of each story's time and pushes the heaviest stories near the browser test timeout, or
past it on CI. The question is whether to raise the timeout, shrink the capacity the stories exercise, or drop the check
for those stories.

## How to resolve

1. Confirm the component's stories at a normal size still run the a11y check.
2. Turn the a11y test off in the capacity story file's meta parameters, not in the shared preview and not story by
   story.
3. Keep the other a11y parameters the file inherits, and change only the test setting.
4. Give the setting a one-line reason: these stories exercise capacity, and the component's accessibility is checked by
   its normal-size stories.
5. Leave the timeout and the capacity the stories exercise as they are.

The owner's reason: the capacity stories exist to check behaviour at capacity, and the component's accessibility is
already checked by its stories at a normal size, so axe over the large DOM only costs time.

## Example

```tsx
// Before: the timeout is raised, or the row count is cut, to make room for axe.
const meta = {
  title: 'Widgets/Feed at capacity',
  parameters: { ...feedStory.parameters },
} satisfies Meta;

// After: the capacity file opts out of the axe test with its reason.
const meta = {
  title: 'Widgets/Feed at capacity',
  parameters: {
    ...feedStory.parameters,
    // These stories exercise the feed at capacity. Its accessibility is checked by its normal-size stories.
    a11y: { ...feedStory.parameters['a11y'], test: 'off' },
  },
} satisfies Meta;
```

## Cases

- A debug panel's story file counted work at capacity over about 2000 rows. Axe was about 60% of each story's time, and
  one story timed out on CI on main. The a11y test was turned off in that file's meta with a one-line reason, instead of
  raising the timeout or shrinking the capacity. (main session fixing flaky Storybook tests after PR #490, uncommitted on
  main)

Status: active
