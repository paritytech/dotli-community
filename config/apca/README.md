# `@config/apca`

## Overview

A Storybook addon that judges text contrast by APCA lightness contrast (Lc) in the a11y check, in place of the WCAG
contrast ratio. The Storybook config lists it among its addons, and nothing else imports it. Internal tooling, never
shipped.

## Responsibilities

- **Owns:**
  - the axe rule and check that score each text element against the APCA Bronze minimum for its font size
  - turning off axe's WCAG `color-contrast` rule
  - setting both in every story's a11y parameters
- **Does not own:** which stories opt out. A story file does that in its own parameters.

## Public API

| Entry                  | Use                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `@config/apca/preview` | The addon's preview entry, which Storybook loads when the config lists `@config/apca`. |

A story file turns the rule off by its id, `apca-contrast`, in its meta parameters:
`a11y: { options: { rules: { 'apca-contrast': { enabled: false } } } }`. That merges with the addon's settings, where an
axe `config` of the story's own would replace the addon's rules and drop the rule's definition.

## Design

- **Bronze minimum:** by computed font size in px.

  | Font size   | Minimum |
  | ----------- | ------- |
  | under 16    | Lc 75   |
  | 16 to 31.99 | Lc 60   |
  | 32 and up   | Lc 45   |

- **Scoring:** the absolute Lc from the APCA reference implementation, whose math is never copied, as its license asks.
  The raw Lc is compared, so a score that rounds up to the minimum still fails.
- **Colors:** the rule selects text as axe's own contrast rule does, and the check reads the foreground and background
  through axe's color helpers. A color axe cannot tell, such as text over an image or under another element, gives no
  verdict, so the element lands in "Incomplete".
- **Gradients:** where axe gives up only because of a gradient, the check walks the elements under the text itself. Each
  color stop, flattened over the layers beneath it, is one background the text may sit on, and the lowest Lc among them
  is the verdict. Rather than guess, the walk leaves the element in "Incomplete" when it meets:
  - an image or a graphic element under the text
  - a gradient sized or blended apart from its element
  - a gradient drawn once at a length offset, or from a box inside its border, which may not reach the text
  - a background clipped to text or to a box inside its border, which paints only part of its element
  - a gradient interpolated in a color space or along a hue path of its own, which may paint colors far from its stops
  - a layer that covers only part of the text
  - a color axe cannot read
  - opacity, blending or a filter on the text, on a layer it scores or on their ancestors
  - a text shadow or translucent text
  - a stack that misses the page's body, where axe adds the page's own background

  Between two stops, a gradient in sRGB can be darker than both. Dark text is still scored by the stops alone.

- **Backdrop filters:** a translucent layer with a backdrop filter shows what lies beneath it blurred and recolored, so
  the walk stops there. It flattens that layer's colors over opaque black and over opaque white in place of the layers
  beneath, and keeps the lower Lc. That bounds the contrast while the text is lighter or darker than both. An opaque
  layer hides its backdrop and needs no bound.
- **Masks:** a `mask-image` is ignored, as axe ignores it. A mask fades only a container's edge, and text outside the
  fade paints as scored.

- **Public axe API only:** the check travels in the settings as a function. A rerun from Storybook's panel, whose
  channel drops functions, reports the rule as incomplete until the view reloads. Tests and normal renders always run
  it.
- **One axe:** the check must import the same axe the a11y check runs, since axe's color helpers read that run's state.
  So axe is a peer dependency, and the package never brings a copy of its own.
- **Unit tests:** the scoring, the reading of gradient stops and the walk's decisions run under Node, the walk over
  plain snapshots of each element's computed style and box. The reads from the page and axe's own color lookup run in
  the stories' own a11y check.
