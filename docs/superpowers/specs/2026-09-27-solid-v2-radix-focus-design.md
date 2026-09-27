# Solid v2 migration: Radix-style popover, menu and dialog focus behaviour

**Status:** the owner decided on 2026-09-27: "popover focus trap should work like it radix". Their follow-up answer chose "Per Radix type": each surface behaves like the Radix primitive it corresponds to.

**Scope:** the shell islands that use `packages/ui/src/components/shell/popover.ts` `createPopover`, plus the auth modal.

## Decisions

### 1. Three modes

`createPopover` gets `mode: "popover" | "menu" | "dialog"`, which replaces `trapFocus`. Each mode follows Radix UI v1's documented keyboard and focus behaviour.

**`popover`** (Radix Popover, non-modal):
- **Open:** the trigger has `aria-haspopup="dialog"`, `aria-expanded` and `aria-controls`, and the surface has `role="dialog"`. On open, focus moves to the first tabbable element in the surface, or to the surface itself (`tabindex="-1"`) when it has none.
- **Focus:** there is no trap. Tabbing moves naturally, and focus leaving the trigger and the surface closes the popover.
- **Escape** closes it and returns focus to the trigger.
- **Outside pointerdown** closes it without returning focus, so focus follows the click.
- **Clicking the trigger** toggles it.
- A blocking modal and `closeOnBlur` still close it.

**`menu`** (Radix DropdownMenu, modal):
- **Open:** the trigger has `aria-haspopup="menu"`, `aria-expanded` and `aria-controls`. Enter, Space or ArrowDown opens it and focuses the first item. A pointer open focuses the menu content.
- **Items:** `role="menu"` with `menuitem`/`menuitemradio` items at `tabindex="-1"`, using roving focus. ArrowUp and ArrowDown loop, Home and End jump, typeahead on the first letter moves focus, and pointer hover focuses an item.
- **Focus:** Tab is prevented inside the menu, so focus stays in it.
- **Closing:** choosing an item closes the menu and returns focus to the trigger, and so does Escape. An outside pointerdown closes it and swallows that click, so the click does not activate what is underneath.

**`dialog`** (Radix Dialog, modal):
- **Roles:** `role="dialog"` and `aria-modal="true"`.
- **Focus:** on open, focus goes to the first tabbable element, and it is trapped.
- **Closing:** Escape closes it and returns focus to the trigger. A click on the backdrop or overlay closes it.
- **While open,** page scroll is locked.

### 2. Which surface gets which mode

| Surface | Mode |
|---|---|
| User popover | `popover` |
| Permissions popover | `popover` (its row dropdowns keep their current select-like keyboard, and an open row dropdown still consumes Escape first) |
| Chains popover | `popover` |
| Verification shield explainer | `popover` (keeps `closeOnBlur`); kept as a disclosure (button + `aria-expanded`, nothing focusable in the panel) |
| Settings, desktop | `popover` |
| Theme menu | `menu` |
| "More" flyout | `menu`, with its rows as `menuitem` |
| Auth (QR) modal | `dialog`, moved onto the primitive and replacing its local trap. It must still not close itself on its own blocking-modal lease |
| Settings, mobile sheet (at or below the 560px breakpoint) | `dialog` |

### 3. Markup

Ids, classes, copy and `.open` toggling stay as they are, because autohide and the Playwright selectors depend on them. Only ARIA roles and attributes change, where Radix differs from today. For example, the user popover gains `role="dialog"` and its trigger `aria-haspopup="dialog"`. Record each ARIA change in the plan's task report.

### 4. Supersedes

This replaces SP4c-D6 ("user popover gains the permissions popover's focus trap") and the `trapFocus: true` choices made in 4b through 4d.

## Testing

**Primitive tests,** one set per mode:
- initial focus;
- Tab behaviour (no trap, trapped, or prevented);
- focus-outside close;
- Escape with focus return;
- outside pointerdown, with no focus return for `popover`, and the click swallowed for `menu`;
- the menu's arrow keys, Home, End and typeahead;
- scroll lock for `dialog`.

**Per-island tests** assert each surface's mode, its ARIA, and one behaviour that sets it apart from the other modes.

**Final check:** the Playwright `ui-smoke` spec passes, and the size check runs as part of the end-of-work verification.
