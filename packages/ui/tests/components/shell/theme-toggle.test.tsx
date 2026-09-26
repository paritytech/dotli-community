// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "@dotli/ui/components/shell/ThemeToggle";
import { initTheme } from "@dotli/ui/theme-controller";
import { setBlockingModalActive } from "@dotli/ui/state/topbar";
import { renderComponent, resetStores, settle } from "../../helpers/solid";
import { stubColorScheme } from "../../helpers/color-scheme";

beforeEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-pref");
});

afterEach(() => {
  resetStores();
});

function themeButton(): HTMLButtonElement {
  return document.getElementById("theme-toggle") as HTMLButtonElement;
}

function themePopover(): HTMLElement {
  return document.getElementById("theme-popover") as HTMLElement;
}

function themeOption(pref: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `.theme-popover-option[data-theme-option="${pref}"]`,
  );
}

function isOpen(): boolean {
  return themePopover().classList.contains("open");
}

/** The toggle, plus a button outside it, with a known stored theme and OS. */
async function renderToggle(
  stored: "light" | "dark" | "system" | null,
  os: "light" | "dark",
): Promise<{ os: ReturnType<typeof stubColorScheme> }> {
  const scheme = stubColorScheme(os);
  if (stored !== null) {
    localStorage.setItem("dotli-theme", stored);
  }
  renderComponent(() => (
    <div>
      <ThemeToggle />
      <button id="outside" type="button">
        Outside
      </button>
    </div>
  ));
  await settle();
  initTheme();
  await settle();
  return { os: scheme };
}

async function openThemeMenu(
  stored: "light" | "dark" | "system",
  os: "light" | "dark",
): Promise<HTMLButtonElement> {
  await renderToggle(stored, os);
  themeButton().click();
  await settle();
  return themeButton();
}

async function pressThemeKey(key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? themePopover()).dispatchEvent(event);
  await settle();
  return event;
}

describe("ThemeToggle", () => {
  it("As a dotli user, the theme button and menu keep their ids, roles and labels", async () => {
    // Given
    await renderToggle("dark", "dark");

    // Then
    const btn = themeButton();
    expect(btn.classList.contains("topbar-btn")).toBe(true);
    expect(btn.getAttribute("aria-haspopup")).toBe("menu");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-controls")).toBe("theme-popover");
    expect(
      ["theme-icon-sun", "theme-icon-moon", "theme-icon-system"].map(
        (id) => document.getElementById(id)?.parentElement,
      ),
    ).toEqual([btn, btn, btn]);
    const popover = themePopover();
    expect(popover.className).toBe("more-popover theme-popover");
    expect(popover.getAttribute("role")).toBe("menu");
    expect(popover.getAttribute("aria-label")).toBe("Theme");
    const options = Array.from(
      popover.querySelectorAll<HTMLButtonElement>(".theme-popover-option"),
    );
    expect(options.map((o) => o.dataset.themeOption)).toEqual([
      "light",
      "dark",
      "system",
    ]);
    expect(options.map((o) => o.textContent)).toEqual([
      "Light",
      "Dark",
      "System",
    ]);
    for (const option of options) {
      expect(option.className).toBe("more-row theme-popover-option");
      expect(option.getAttribute("role")).toBe("menuitemradio");
      expect(option.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("As a dotli user, the theme button opens a menu with the current theme checked", async () => {
    // Given
    await renderToggle("light", "dark");
    const btn = themeButton();
    const popover = themePopover();

    // When
    btn.click();
    await settle();

    // Then
    expect(popover.id).toBe("theme-popover");
    expect(popover.classList.contains("open")).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(themeOption("light")?.getAttribute("aria-checked")).toBe("true");
    expect(themeOption("dark")?.getAttribute("aria-checked")).toBe("false");
    expect(themeOption("system")?.getAttribute("aria-checked")).toBe("false");
    expect(document.activeElement).toBe(themeOption("light"));
    expect(btn.title).toBe("Theme: Light");
    expect(btn.getAttribute("aria-label")).toBe("Theme: Light");
  });

  it("As a dotli user, clicking the theme button again closes the menu", async () => {
    // Given
    const btn = await openThemeMenu("dark", "dark");

    // When
    btn.click();
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("As a dotli user, I select Dark from the theme menu and it applies and persists", async () => {
    // Given
    const btn = await openThemeMenu("light", "light");
    const popover = themePopover();

    // When
    themeOption("dark")?.click();
    await settle();

    // Then
    expect(localStorage.getItem("dotli-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme-pref")).toBe(
      "dark",
    );
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(themeOption("dark")?.getAttribute("aria-checked")).toBe("true");
    expect(themeOption("light")?.getAttribute("aria-checked")).toBe("false");
    expect(popover.classList.contains("open")).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(btn);
    expect(btn.title).toBe("Theme: Dark");
    expect(btn.getAttribute("aria-label")).toBe("Theme: Dark");
  });

  it("As a dotli user, I select System from the theme menu and the theme resolves from the OS", async () => {
    // Given
    await openThemeMenu("dark", "light");

    // When
    themeOption("system")?.click();
    await settle();

    // Then
    expect(localStorage.getItem("dotli-theme")).toBe("system");
    expect(document.documentElement.getAttribute("data-theme-pref")).toBe(
      "system",
    );
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(themeButton().title).toBe("Theme: System");
  });

  it("As a keyboard user, I press ArrowDown in the theme menu and focus moves to the next option", async () => {
    // Given
    await openThemeMenu("light", "dark");

    // When
    const event = await pressThemeKey("ArrowDown");

    // Then
    expect(document.activeElement).toBe(themeOption("dark"));
    expect(event.defaultPrevented).toBe(true);
  });

  it("As a keyboard user, I press ArrowDown on the last theme option and focus wraps to the first", async () => {
    // Given
    await openThemeMenu("system", "dark");

    // When
    await pressThemeKey("ArrowDown");

    // Then
    expect(document.activeElement).toBe(themeOption("light"));
  });

  it("As a keyboard user, I press ArrowUp on the first theme option and focus wraps to the last", async () => {
    // Given
    await openThemeMenu("light", "dark");

    // When
    await pressThemeKey("ArrowUp");

    // Then
    expect(document.activeElement).toBe(themeOption("system"));
  });

  it("As a keyboard user, I press Home in the theme menu and focus moves to the first option", async () => {
    // Given
    await openThemeMenu("system", "dark");

    // When
    await pressThemeKey("Home");

    // Then
    expect(document.activeElement).toBe(themeOption("light"));
  });

  it("As a keyboard user, I press End in the theme menu and focus moves to the last option", async () => {
    // Given
    await openThemeMenu("light", "dark");

    // When
    await pressThemeKey("End");

    // Then
    expect(document.activeElement).toBe(themeOption("system"));
  });

  it("As a keyboard user, I press Escape in the theme menu and it closes without changing the theme", async () => {
    // Given
    const btn = await openThemeMenu("light", "dark");

    // When
    await pressThemeKey("Escape");

    // Then
    expect(isOpen()).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(btn);
    expect(localStorage.getItem("dotli-theme")).toBe("light");
  });

  it("As a keyboard user, I press Tab in the theme menu and it closes so focus leaves the menu", async () => {
    // Given
    const btn = await openThemeMenu("light", "dark");

    // When
    const event = await pressThemeKey("Tab");

    // Then
    expect(isOpen()).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    // The browser moves focus on: Tab is not swallowed.
    expect(event.defaultPrevented).toBe(false);
  });

  it("As a keyboard user, I press Enter on a focused option and it selects that theme", async () => {
    // Given
    const btn = await openThemeMenu("light", "dark");
    await pressThemeKey("ArrowDown");

    // When: a focused button turns Enter into a click.
    (document.activeElement as HTMLButtonElement).click();
    await settle();

    // Then
    expect(localStorage.getItem("dotli-theme")).toBe("dark");
    expect(document.activeElement).toBe(btn);
  });

  it("As a dotli user, clicking outside closes the theme menu", async () => {
    // Given
    const btn = await openThemeMenu("dark", "dark");

    // When
    document.getElementById("outside")?.click();
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("As a dotli user, the theme menu closes when a blocking modal comes up", async () => {
    // Given
    const btn = await openThemeMenu("dark", "dark");

    // When
    setBlockingModalActive(true);
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("As a mobile user, the More menu's Theme row opens the theme menu by clicking the theme button", async () => {
    // Given
    await renderToggle("dark", "dark");
    const row = document.createElement("button");
    row.className = "more-row";
    row.dataset.target = "theme-toggle";
    row.addEventListener("click", (e) => {
      // As topbar.ts's More menu does.
      e.stopPropagation();
      document.getElementById(row.dataset.target ?? "")?.click();
    });
    document.body.append(row);

    // When
    row.click();
    await settle();

    // Then
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(themeOption("dark"));
    row.remove();
  });

  it("As a mobile user, picking a theme while the theme button is hidden hands focus to the More button", async () => {
    // Given: on narrow screens CSS hides the theme button, so it cannot
    // take focus; the menu is reached through the More button.
    await openThemeMenu("dark", "dark");
    const more = document.createElement("button");
    more.id = "more-button";
    document.body.append(more);
    themeButton().focus = () => undefined;

    // When
    themeOption("light")?.click();
    await settle();

    // Then
    expect(localStorage.getItem("dotli-theme")).toBe("light");
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(more);
    more.remove();
  });

  it("As a visitor on the landing page, the theme menu still works after the page moves the button and menu out of the shell", async () => {
    // Given: ui.ts moves both into the landing page's top-right corner,
    // outside the root Solid rendered them in.
    await renderToggle("light", "dark");
    const landingAuth = document.createElement("div");
    landingAuth.id = "landing-auth";
    document.body.append(landingAuth);
    landingAuth.append(themeButton(), themePopover());
    const btn = themeButton();

    // When
    btn.click();
    await settle();

    // Then
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(themeOption("light"));

    // When
    await pressThemeKey("ArrowDown");

    // Then
    expect(document.activeElement).toBe(themeOption("dark"));

    // When
    themeOption("dark")?.click();
    await settle();

    // Then
    expect(localStorage.getItem("dotli-theme")).toBe("dark");
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(btn);
    landingAuth.remove();
  });

  it("As a dotli user, the System option's label follows the store after an OS change", async () => {
    // Given
    const { os } = await renderToggle(null, "dark");

    // When
    os.set("light");
    await settle();

    // Then
    expect(themeButton().title).toBe("Theme: System");
    expect(themeOption("system")?.getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
