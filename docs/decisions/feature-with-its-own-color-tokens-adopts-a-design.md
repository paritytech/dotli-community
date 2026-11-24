# A feature with its own color tokens adopts a design

A developer adopts an outside design for a feature that already has its own small family of color tokens in the shared
global stylesheet. Part of the family may be a palette that other code, such as products, also references by name, and
part may be read only by the feature's own views. The design paints some of the feature's surfaces in colors its tokens
do not hold, such as the user's own items, the base surface or neutral controls. General tokens that come close
already exist, such as an inverse surface, the page background or a strong fill. The question is whether the feature's
views switch to those close general tokens, or the feature's own tokens carry the design.

## How to resolve

1. Keep the feature's token names, and retune their values to the design's colors.
2. When the design adds a role none of the feature's tokens holds, add a token for it to the feature's family.
3. Point the feature's views at the feature's tokens, not at general tokens that come close.

The owner chose to retune the feature's tokens without stating a further reason.

## Example

```css
/* not: the feature's views borrow close general tokens */
.mine {
  background: var(--surface-inverse);
}
.pane {
  background: var(--bg-page);
}

/* instead: the feature's family carries the design */
:root {
  --notes-bg-mine: #e8e9ee; /* was rgba(120, 169, 255, 0.18) */
  --notes-bg-surface: #101114; /* retuned to the design */
  --notes-bg-control: #2a2b31; /* a role the design adds */
}
.mine {
  background: var(--notes-bg-mine);
}
.pane {
  background: var(--notes-bg-surface);
}
```

## Cases

- The host's chat feature adopted the Polkadot App chat design, whose own-message, base surface and neutral control
  colors were not in the chat tokens. Offered close general tokens, with or without deleting a chat-only token no view
  read any more, the owner chose to retune the chat tokens and add chat tokens for roles the design adds.
  (`docs/_plans/chat-figma-design-design.md`)

Related: [design-gives-px-line-heights](design-gives-px-line-heights.md) also carries a design by changing the values
of the tokens that exist.

Status: active
