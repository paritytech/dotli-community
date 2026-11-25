# A focus ring only for keyboard focus

A developer styles a focus ring that should show when the user reaches a control with the keyboard and not when they
click it. Testing it, they notice the browser matches `:focus-visible` on a text field the user clicked, so the ring
shows on a click there. The question is whether to build a page helper that tracks the last input, keyboard or pointer,
and show the ring from it instead.

## How to resolve

1. Style the ring with the platform's `:focus-visible`.
2. Accept where the browser matches it, a clicked text field included. Do not work around that match.
3. Build no input-modality tracker for the ring, neither a page-wide one nor one in the component.

The owner's reason: the browser already provides this through `:focus-visible`, so a hand-built tracker is not wanted.
This follows the rule in AGENTS.md to prefer the framework's own mechanism over hand-written machinery.

## Example

```css
.field:focus-visible {
  outline: 2px solid var(--focus-ring);
}
```

Not this:

```ts
// A page helper that records the last input so a component can set its ring by hand.
document.addEventListener('keydown', () => (root.dataset['input'] = 'keyboard'), true);
document.addEventListener('pointerdown', () => (root.dataset['input'] = 'pointer'), true);
```

```css
:global([data-input='keyboard']) .field:focus {
  outline: 2px solid var(--focus-ring);
}
```

## Cases

- A text field in a side panel showed the focus ring on a click, since browsers match `:focus-visible` on a clicked
  text field. Asked whether to build a page input-modality helper so the ring showed only for keyboard focus, the owner
  rejected the helper and kept plain `:focus-visible`. (architecture change, design docs/\_plans/staged-mode-design.md)
  The same exchange decided [closing a panel focuses an auto-hiding bar](closing-a-panel-focuses-an-auto-hiding-bar.md).

Status: active
