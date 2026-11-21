# A status mark drawn around an icon

You are building a row that shows an entity's icon, and the design carries the entity's state in a mark around that
icon: a filled disc behind it in one state, a ring, an arc or a dashed outline in others. AGENTS.md says icons stand bare
on the surface, never in a decorative tile or tinted shape. The question is whether the mark breaks that rule, or whether
the icon must stay bare with the state shown apart from it.

## How to resolve

1. Check whether the shape around the icon changes with the state. If it looks the same in every state, it is a
   decorative tile, and the icon stays bare.
2. When the shape, its fill or its color is what tells the state, treat it as a functional frame, like a QR code's quiet
   zone, and draw it around the icon, a filled disc included.
3. When the mark comes from a sibling app's design, draw it as that design draws it. Do not trade its shapes for a bare
   icon beside a separate status dot, or keep only the outline shapes so the icon is never on a fill.

The owner chose to draw the sibling app's mark as is, on the stated ground that the mark's shape carries the state.

## Example

```text
healthy       (●)  icon in the inverse color on a solid disc
degraded      (◔)  arc at the measured share, colored by band
stopped       (○×) open ring with a cross
connecting    (◌)  pulsing scalloped ring
not:          icon  • Healthy     <- bare icon plus a separate status dot
not:          (○)   rings only    <- no disc, so the icon is never on a fill
```

## Cases

- A network popover row showed each chain's glyph inside the mobile app's health mark, a solid disc when healthy and
  rings or arcs in the other states. Offered the mark as is, a bare glyph with a status dot and words, or rings only,
  the owner took the mark as is. (design `docs/_plans/network-chain-indicators-design.md`, network popover chain
  indicators change)

Status: active
