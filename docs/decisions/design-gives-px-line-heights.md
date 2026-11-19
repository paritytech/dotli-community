# A design gives each text size a fixed px line height

A developer adopts a design's type scale into the tokens. The design pairs each size with a fixed px line height, such
as 18 over 26. The tokens already hold a few unitless line-height ratios that places pair with a size. The question is
whether each size gets its own px line-height token beside its size token, or the ratios carry it.

## How to resolve

1. Divide each px line height by its size to get the design's ratio for that step.
2. Group the ratios that sit close together. A type scale usually comes down to two or three multipliers.
3. Set the existing ratio tokens to those multipliers, adding a ratio token only for a cluster none of them covers.
4. Give each place that sets a stepped size the ratio token of its step's cluster, switching any that pairs it with
   another cluster's ratio. Only the drift within a pixel that the clustering leaves is fine.
5. Add no px line-height token per size, and no tokens named after the design's steps.

The owner's reason: a design's px line height is its size times a ratio, and a scale has only a few such ratios, so the
ratios are the thing to carry.

## Example

The design gives `20/29`, `16/23` and `14/16`. The ratios are 1.45, 1.44 and 1.14.

```css
/* not: a px line height per size */
--text-lead: 20px;
--lh-lead: 29px;
--text-body: 16px;
--lh-body-px: 23px;

/* instead: the few ratios the steps cluster on */
--lh-body: 1.44;
--lh-tight: 1.14;
```

```css
.intro {
  font-size: var(--text-lead);
  /* was var(--lh-tight): 20 x 1.14 = 22.8, far from 29 */
  line-height: var(--lh-body); /* 20 x 1.44 = 28.8, within a pixel of 29 */
}
```

## Cases

- Brand type steps of 56/64, 24/31, 18/26 and 16/23 came with the brand fonts. Offered a px line-height token per size
  role, or tokens named after the brand steps, the owner kept the ratio tokens and changed only their values, noting
  the steps come down to two or three multipliers. Shown that three ratios, 1.14, 1.29 and 1.44, land every step within
  a pixel once each place uses its step's ratio, the owner agreed. (`docs/_plans/brand-fonts-design.md`, branch
  `feat/landing-horizon`, PR #493)

Status: active
