import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bindVerificationShield,
  setVerificationShieldState,
  verificationShieldMarkup,
  VERIFICATION_SHIELD_ID,
  VERIFICATION_TOOLTIP_ID,
} from "@dotli/ui/verification-shield";

let unbind: (() => void) | null = null;

function button(): HTMLButtonElement {
  return document.getElementById(VERIFICATION_SHIELD_ID) as HTMLButtonElement;
}

function panel(): HTMLElement {
  return document.getElementById(VERIFICATION_TOOLTIP_ID) as HTMLElement;
}

function isOpen(): boolean {
  return (
    panel().classList.contains("open") &&
    button().getAttribute("aria-expanded") === "true"
  );
}

function rowFor(state: string): HTMLElement {
  return panel().querySelector(
    `.verification-tooltip-row[data-state="${state}"]`,
  ) as HTMLElement;
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="topbar">
      <div class="topbar-url-pill">${verificationShieldMarkup()}<span class="topbar-url-text">app.dot</span></div>
      <button id="other-button">Other</button>
    </div>
    <div id="app"></div>
  `;
  unbind = bindVerificationShield();
});

afterEach(() => {
  unbind?.();
  unbind = null;
});

describe("verification shield", () => {
  it("As a keyboard user, the shield is a real button that toggles the explainer", () => {
    // Given
    const trigger = button();
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("aria-controls")).toBe(VERIFICATION_TOOLTIP_ID);
    expect(isOpen()).toBe(false);

    // When: Enter and Space on a native button dispatch click
    trigger.click();

    // Then
    expect(isOpen()).toBe(true);

    // When
    trigger.click();

    // Then
    expect(isOpen()).toBe(false);
  });

  it("As a keyboard user, Escape closes the explainer and returns focus to the shield", () => {
    // Given
    button().click();
    button().blur();
    expect(document.activeElement).toBe(document.body);

    // When
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    // Then
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(button());
  });

  it("As a touch user, tapping elsewhere dismisses the explainer but tapping it keeps it up", () => {
    // Given
    button().click();

    // When: a tap lands on the panel copy
    panel()
      .querySelector(".verification-tooltip-title")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // Then
    expect(isOpen()).toBe(true);

    // When: a tap lands outside the shield
    document
      .getElementById("other-button")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // Then
    expect(isOpen()).toBe(false);
  });

  it("As a touch user, tapping into the app frame dismisses the explainer", () => {
    // Given
    button().click();

    // When: focus leaves the host window for the cross-origin iframe
    window.dispatchEvent(new Event("blur"));

    // Then
    expect(isOpen()).toBe(false);
  });

  it("As a dotli integrator, a blocking modal closes the explainer", () => {
    // Given
    button().click();

    // When
    window.dispatchEvent(
      new CustomEvent("dotli:blocking-modal-active", {
        detail: { active: true },
      }),
    );

    // Then
    expect(isOpen()).toBe(false);
  });

  it("As a screen reader user, the state is in the button name, not only its colour", () => {
    // When
    setVerificationShieldState("trusted");

    // Then
    expect(button().classList.contains("trusted")).toBe(true);
    expect(button().classList.contains("verified")).toBe(false);
    expect(button().getAttribute("aria-label")).toContain("trusted provider");
    expect(rowFor("trusted").classList.contains("is-current")).toBe(true);
    expect(rowFor("verified").classList.contains("is-current")).toBe(false);

    // When
    setVerificationShieldState("verified");

    // Then
    expect(button().classList.contains("verified")).toBe(true);
    expect(button().classList.contains("trusted")).toBe(false);
    expect(button().getAttribute("aria-label")).toContain("light client");
    expect(rowFor("verified").classList.contains("is-current")).toBe(true);
    expect(rowFor("trusted").classList.contains("is-current")).toBe(false);
  });

  it("As a low-vision user, each state ships its own glyph", () => {
    // Then
    const glyphs = button().querySelectorAll(".verification-shield-icon");
    expect(glyphs).toHaveLength(2);
    const [verified, trusted] = Array.from(glyphs).map(
      (svg) => svg.querySelector("path")?.getAttribute("d") ?? "",
    );
    expect(verified).not.toBe(trusted);
    for (const state of ["verified", "trusted"]) {
      expect(
        rowFor(state).querySelector(`.verification-tooltip-icon.is-${state}`),
      ).not.toBeNull();
    }
  });
});
