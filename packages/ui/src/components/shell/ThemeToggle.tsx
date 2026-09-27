// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEffect, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { themeStore, type ThemePref } from "../../state/theme";
import { selectThemePref } from "../../theme-controller";
import { useStore } from "../use-store";
import { createPopover, focusTrigger } from "./popover";

const THEME_LABEL: Record<ThemePref, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

/**
 * The shell's theme button (`#theme-toggle`) and its menu (`#theme-popover`),
 * a shell island (see islands.tsx): Shell.tsx prerenders the same markup
 * statically (title "Theme", no option checked), and this component is
 * swapped in for it after boot. The menu follows the menu-button pattern:
 * opening focuses the checked option, ArrowUp/ArrowDown (wrapping), Home and
 * End move between options, Escape closes and hands focus back to the
 * button, and Tab closes so focus moves on. Picking an option applies it
 * through theme-controller.ts, closes the menu and focuses the button (or
 * the "More" button, when the theme button is hidden on narrow screens).
 *
 * The button's icon comes from CSS on `<html data-theme-pref>`, which the
 * inline bootstrap script and theme-controller.ts own, never this component.
 * The mobile "More" menu's Theme row opens this menu by calling `.click()`
 * on the button.
 */
export function ThemeToggle(): JSX.Element {
  let button: HTMLButtonElement | undefined;
  let popover: HTMLDivElement | undefined;
  const theme = useStore(themeStore);
  const pref = (): ThemePref => theme().pref;
  const title = (): string => `Theme: ${THEME_LABEL[pref()]}`;

  const menu = createPopover({
    trigger: () => button,
    surface: () => popover,
  });

  const options = (): HTMLButtonElement[] =>
    Array.from(
      popover?.querySelectorAll<HTMLButtonElement>(".theme-popover-option") ??
        [],
    );

  createEffect(menu.open, (open) => {
    if (!open) {
      return;
    }
    // Focus lands on the checked option so arrow keys and Escape work
    // immediately after opening.
    const all = options();
    const checked = untrack(pref);
    (
      all.find((option) => option.dataset.themeOption === checked) ?? all[0]
    ).focus();
  });

  // Native listeners (added in the refs below), not Solid's onClick/onKeyDown:
  // Solid 2 delegates those to the root's container, which is the detached
  // element the island renders into before it is swapped in (islands.tsx).
  // The landing page (components/landing/) also moves the button and the
  // menu around.
  const onKeyDown = (e: KeyboardEvent): void => {
    // Escape is the popover's (createPopover): it closes and returns focus.
    const all = options();
    const index = all.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const delta = e.key === "ArrowDown" ? 1 : -1;
      next = all[(index + delta + all.length) % all.length];
    } else if (e.key === "Home") {
      next = all[0];
    } else if (e.key === "End") {
      next = all[all.length - 1];
    } else if (e.key === "Tab") {
      // Options are not tabbable (tabindex=-1), so Tab leaves the menu.
      menu.setOpen(false);
    }
    if (next !== undefined) {
      e.preventDefault();
      next.focus();
    }
  };

  const onClick = (e: MouseEvent): void => {
    const option = (e.target as HTMLElement).closest<HTMLElement>(
      ".theme-popover-option",
    );
    const next = option?.dataset.themeOption;
    if (next === "light" || next === "dark" || next === "system") {
      selectThemePref(next);
      menu.setOpen(false);
      focusTrigger(button);
    }
  };

  return (
    <>
      <button
        ref={(el) => {
          button = el;
          el.addEventListener("click", menu.toggle);
        }}
        id="theme-toggle"
        class="topbar-btn"
        title={title()}
        aria-label={title()}
        aria-haspopup="menu"
        aria-expanded={menu.open() ? "true" : "false"}
        aria-controls="theme-popover"
      >
        <svg
          id="theme-icon-sun"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
        <svg
          id="theme-icon-moon"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
        <svg
          id="theme-icon-system"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      </button>
      <div
        ref={(el) => {
          popover = el;
          el.addEventListener("keydown", onKeyDown);
          el.addEventListener("click", onClick);
        }}
        class={["more-popover theme-popover", { open: menu.open() }]}
        id="theme-popover"
        role="menu"
        aria-label="Theme"
      >
        <button
          class="more-row theme-popover-option"
          role="menuitemradio"
          aria-checked={pref() === "light" ? "true" : "false"}
          data-theme-option="light"
          tabindex="-1"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
          <span>Light</span>
          <svg
            class="theme-popover-check"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
        <button
          class="more-row theme-popover-option"
          role="menuitemradio"
          aria-checked={pref() === "dark" ? "true" : "false"}
          data-theme-option="dark"
          tabindex="-1"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
          <span>Dark</span>
          <svg
            class="theme-popover-check"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
        <button
          class="more-row theme-popover-option"
          role="menuitemradio"
          aria-checked={pref() === "system" ? "true" : "false"}
          data-theme-option="system"
          tabindex="-1"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          <span>System</span>
          <svg
            class="theme-popover-check"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
      </div>
    </>
  );
}
