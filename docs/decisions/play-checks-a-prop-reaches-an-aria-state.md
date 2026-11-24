# A story play checks that a prop reaches an ARIA state

A developer writes or trims a component's story file under the stories contract (`docs/code/stories.md`), where a play
goes when it restates the types or a prop passed through unchanged (C1) and stays when it documents a public behaviour a
user sees that the types do not show (K1). They find a play that checks a state prop, such as `disabled`, lands as an
ARIA attribute, such as `aria-disabled`, on the component and its parts. The component keeps those parts focusable or
otherwise skips the native attribute, so the ARIA attribute is the only way assistive technology learns the state. The
question is whether the check is a prop passed through, and goes, or a behaviour a user sees, and stays.

## How to resolve

1. Ask whether an assistive-technology user acts on the state the attribute carries, such as skipping a control that is
   announced as disabled.
2. Ask whether the types show how the prop reaches that user. A boolean prop does not say that it becomes an ARIA
   attribute rather than the native one, or that it reaches the parts as well as the root.
3. When both hold, keep the check as K1. Assert the role and the ARIA state a user acts on, on the root and on the
   parts that carry it, never a class or the copy.
4. Give the assertion a one-line comment on why the ARIA attribute carries the state, such as that the parts stay
   focusable.

The owner kept such a check as K1: an assistive-technology user acts on the state, and the types do not show that it
becomes an ARIA attribute rather than the native one.

## Example

```tsx
/** As a user, I find a disabled picker announced as disabled, and pressing an option picks nothing. */
export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ canvas, step }) => {
    const option = canvas.getByRole('button', { name: 'Small' });
    // The options stay focusable, so the state reaches assistive technology only through `aria-disabled`.
    await step('Then the picker and its options are announced as disabled', async () => {
      await expect(canvas.getByRole('group')).toHaveAttribute('aria-disabled', 'true');
      await expect(option).toHaveAttribute('aria-disabled', 'true');
    });
  },
};
```

Not this: dropping the check as C1 because the `disabled` prop maps straight to an attribute.

## Cases

- A segmented control's disabled story checked that its `disabled` prop reaches `aria-disabled` on the group and on each
  option, which stay focusable. While the story file was rewritten under the stories contract, the owner restored the
  check as K1 instead of dropping it as C1. (branch `chore/story-contract`, commit efe330f22,
  `docs/_plans/story-contract-design.md`)

Status: active
