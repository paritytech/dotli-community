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
  through axe's color helpers. A color axe cannot tell, such as text over an image or a gradient, gives no verdict, so
  the element lands in "Incomplete".
- **Public axe API only:** the check travels in the settings as a function. A rerun from Storybook's panel, whose
  channel drops functions, reports the rule as incomplete until the view reloads. Tests and normal renders always run
  it.
- **One axe:** the check must import the same axe the a11y check runs, since axe's color helpers read that run's state.
  So axe is a peer dependency, and the package never brings a copy of its own.
- **Unit tests:** the scoring runs under Node. The color lookup runs in the stories' own a11y check.
