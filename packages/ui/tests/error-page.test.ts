// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach } from "vitest";
import { showError, showErrorPage } from "@dotli/ui/ui";

const XSS = '<img src=x onerror="alert(1)">';

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("showErrorPage escaping", () => {
  // The detail line carries the domain the visitor typed, so every segment of
  // it is attacker-influenced. A raw `innerHTML` write here is an XSS sink.
  it("As a visitor, markup in an error message is shown to me as text", () => {
    showErrorPage({ title: "t", detail: XSS });
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".error-page-detail")?.textContent).toBe(XSS);
  });

  it("As a visitor, markup in the plain parts of a message is shown to me as text", () => {
    showErrorPage({ title: "t", detail: [XSS, " tail"] });
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".error-page-detail")?.textContent).toBe(
      `${XSS} tail`,
    );
  });

  it("As a visitor, markup in the bolded parts of a message is shown to me as text", () => {
    showErrorPage({ title: "t", detail: [{ strong: XSS }] });
    expect(document.querySelector("img")).toBeNull();
    const strong = document.querySelector(".error-page-detail strong");
    expect(strong?.textContent).toBe(XSS);
  });

  it("As a visitor, markup in an error title is shown to me as text", () => {
    showErrorPage({ title: XSS });
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".error-page-title")?.textContent).toBe(XSS);
  });

  it("As a visitor, markup in a tip is shown to me as text", () => {
    showErrorPage({ title: "t", tips: [XSS] });
    expect(document.querySelector("img")).toBeNull();
    expect(
      document.querySelector(".error-page-tips-list li")?.textContent,
    ).toBe(XSS);
  });

  it("As a visitor, markup in a button label is shown to me as text", () => {
    showErrorPage({
      title: "t",
      actions: [{ label: XSS, onClick: () => undefined }],
    });
    expect(document.querySelector("img")).toBeNull();
    expect(
      document.querySelector("#error-retry-btn .error-page-retry-label")
        ?.textContent,
    ).toBe(XSS);
  });
});

describe("showErrorPage primary action", () => {
  const noop = (): void => undefined;

  it("As a visitor, a lone button is the recommended one", () => {
    showErrorPage({ title: "t", actions: [{ label: "A", onClick: noop }] });
    expect(document.querySelector("#error-retry-btn")?.className).toContain(
      "error-page-retry--primary",
    );
  });

  it("As a visitor, the first button is recommended when none is marked", () => {
    showErrorPage({
      title: "t",
      actions: [
        { label: "A", onClick: noop },
        { label: "B", onClick: noop },
      ],
    });
    expect(document.querySelector("#error-retry-btn")?.className).toContain(
      "error-page-retry--primary",
    );
    expect(
      document.querySelector("#error-retry-btn-1")?.className,
    ).not.toContain("error-page-retry--primary");
  });

  // The gated failover screen puts `Go Back` second and marks it primary, so
  // this ordering is the one the two-step confirmation depends on.
  it("As a visitor, the button marked primary is the recommended one wherever it sits", () => {
    showErrorPage({
      title: "t",
      actions: [
        { label: "A", onClick: noop },
        { label: "B", primary: true, onClick: noop },
      ],
    });
    expect(document.querySelector("#error-retry-btn")?.className).not.toContain(
      "error-page-retry--primary",
    );
    expect(document.querySelector("#error-retry-btn-1")?.className).toContain(
      "error-page-retry--primary",
    );
  });

  // Reading order, DOM order and tab order have to agree. Placing the primary
  // with CSS `order` instead left the tab sequence running right to left.
  it("As a keyboard user, I reach the buttons in the order I read them", () => {
    showErrorPage({
      title: "t",
      actions: [
        { label: "Reload", primary: true, onClick: noop },
        { label: "Open Settings", onClick: noop },
      ],
    });
    const labels = [
      ...document.querySelectorAll(".error-page-retry-label"),
    ].map((n) => n.textContent);
    expect(labels).toEqual(["Open Settings", "Reload"]);
  });

  it("As a visitor, a lone button keeps its place", () => {
    showErrorPage({
      title: "t",
      actions: [{ label: "Only", primary: true, onClick: noop }],
    });
    const labels = [
      ...document.querySelectorAll(".error-page-retry-label"),
    ].map((n) => n.textContent);
    expect(labels).toEqual(["Only"]);
  });

  // The distinguishing case: the primary is first in the array but rendered
  // last, so an id keyed on render position instead of array position would
  // hand `#error-retry-btn` to the wrong button. The reverse arrangement does
  // not catch it, because there the two positions coincide.
  it("As a test author, the first action keeps its id even when it renders last", () => {
    showErrorPage({
      title: "t",
      actions: [
        { label: "Reload", primary: true, onClick: noop },
        { label: "Open Settings", onClick: noop },
      ],
    });
    expect(
      document.querySelector("#error-retry-btn .error-page-retry-label")
        ?.textContent,
    ).toBe("Reload");
    expect(
      document.querySelector("#error-retry-btn-1 .error-page-retry-label")
        ?.textContent,
    ).toBe("Open Settings");
  });

  it("As a test author, the first action keeps its id whichever button is primary", () => {
    showErrorPage({
      title: "t",
      actions: [
        { label: "First", onClick: noop },
        { label: "Second", primary: true, onClick: noop },
      ],
    });
    expect(
      document.querySelector("#error-retry-btn .error-page-retry-label")
        ?.textContent,
    ).toBe("First");
  });
});

describe("showErrorPage optional blocks", () => {
  it("As a visitor, I see no empty Try list when there is nothing to suggest", () => {
    showErrorPage({ title: "t", tips: [] });
    expect(document.querySelector(".error-page-tips")).toBeNull();
  });

  it("As a visitor, I see no empty button row when there is nothing to click", () => {
    showErrorPage({ title: "t", actions: [] });
    expect(document.querySelector(".error-page-actions")).toBeNull();
  });

  it("As a visitor, clicking a button that opens a panel leaves the panel open", () => {
    let got: unknown = null;
    showErrorPage({
      title: "t",
      actions: [
        {
          label: "A",
          onClick: (event) => {
            got = event;
          },
        },
      ],
    });
    document.querySelector<HTMLButtonElement>("#error-retry-btn")?.click();
    expect(got).not.toBeNull();
    expect(typeof (got as MouseEvent).stopPropagation).toBe("function");
  });

  it("As a visitor, I see the warning mark only on a screen that warns me", () => {
    showErrorPage({ title: "t", glyph: "warning" });
    expect(document.querySelector(".error-page-glyph--warning")).not.toBeNull();

    showErrorPage({ title: "t" });
    expect(document.querySelector(".error-page-glyph")).toBeNull();
  });
});

describe("showErrorPage focus", () => {
  // The button that triggered the render is gone, so without this the focus
  // lands on body and a screen reader announces nothing. The interstitial
  // replaces one error screen with another in place, which is the worst case.
  it("As a screen-reader user, the new screen is announced when it replaces the old one", () => {
    showErrorPage({ title: "Your connection won't be verified" });
    const title = document.querySelector(".error-page-title");
    expect(document.activeElement).toBe(title);
  });

  it("As a keyboard user, the title does not take a tab stop", () => {
    showErrorPage({ title: "t" });
    expect(
      document.querySelector(".error-page-title")?.getAttribute("tabindex"),
    ).toBe("-1");
  });
});

describe("showError shim", () => {
  it("As a visitor, tips passed to the shorthand still reach the page", () => {
    showError("t", "d", undefined, ["Check the cable."]);
    expect(
      document.querySelector(".error-page-tips-list li")?.textContent,
    ).toBe("Check the cable.");
  });

  it("As a visitor, a bare retry callback becomes a Retry button", () => {
    let clicked = false;
    showError("t", "d", () => {
      clicked = true;
    });
    const btn = document.querySelector<HTMLButtonElement>("#error-retry-btn");
    expect(btn?.textContent).toContain("Retry");
    btn?.click();
    expect(clicked).toBe(true);
  });
});
