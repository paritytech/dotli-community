# `@config/apca`

## Overview

Judges text contrast by APCA lightness contrast (Lc) in the Storybook a11y check, in place of the WCAG contrast ratio.
Internal tooling, never shipped.

## Responsibilities

- **Owns:**
  - the axe rule and check that score each text element against the APCA Bronze minimum for its font size
  - turning off axe's WCAG `color-contrast` rule
- **Does not own:** where the settings apply. The Storybook preview sets them, and a story opts out there.

## Public API

| Entry          | Use                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `@config/apca` | `axeConfig`, the axe settings for the a11y check, and `APCA_RULE_ID`, the APCA rule's id, by which a story turns the rule off. |

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
  through axe's color helpers. A color axe cannot tell, such as text over an image or a gradient, gives no verdict, so
  the element lands in "Incomplete".
- **Public axe API only:** the check travels in the settings as a function. A rerun from Storybook's panel, whose
  channel drops functions, reports the rule as incomplete until the view reloads. Tests and normal renders always run
  it.
- **One axe:** the check imports the same axe the a11y check runs, since axe's color helpers read that run's state.
- **Unit tests:** the scoring runs under Node. The color lookup runs in the stories' own a11y check.
