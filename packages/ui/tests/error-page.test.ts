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
  it("escapes a plain-string detail", () => {
    showErrorPage({ title: "t", detail: XSS });
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".error-page-detail")?.textContent).toBe(XSS);
  });

  it("escapes the plain segments of a segmented detail", () => {
    showErrorPage({ title: "t", detail: [XSS, " tail"] });
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".error-page-detail")?.textContent).toBe(
      `${XSS} tail`,
    );
  });

  it("escapes the bolded segments of a segmented detail", () => {
    showErrorPage({ title: "t", detail: [{ strong: XSS }] });
    expect(document.querySelector("img")).toBeNull();
    const strong = document.querySelector(".error-page-detail strong");
    expect(strong?.textContent).toBe(XSS);
  });

  it("escapes the title", () => {
    showErrorPage({ title: XSS });
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector(".error-page-title")?.textContent).toBe(XSS);
  });

  it("escapes tips", () => {
    showErrorPage({ title: "t", tips: [XSS] });
    expect(document.querySelector("img")).toBeNull();
    expect(
      document.querySelector(".error-page-tips-list li")?.textContent,
    ).toBe(XSS);
  });

  it("escapes action labels", () => {
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

  it("treats the only action as primary", () => {
    showErrorPage({ title: "t", actions: [{ label: "A", onClick: noop }] });
    expect(document.querySelector("#error-retry-btn")?.className).toContain(
      "error-page-retry--primary",
    );
  });

  it("defaults to the first action when none declares itself primary", () => {
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
  it("honours a primary declared on a later action", () => {
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
  it("renders the primary last so tab order matches reading order", () => {
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

  it("leaves a single action alone", () => {
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
  it("keeps #error-retry-btn on the first action even when it renders last", () => {
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

  it("keeps #error-retry-btn on the first action whichever one is primary", () => {
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
  it("omits the tips block when there are no tips", () => {
    showErrorPage({ title: "t", tips: [] });
    expect(document.querySelector(".error-page-tips")).toBeNull();
  });

  it("omits the actions block when there are no actions", () => {
    showErrorPage({ title: "t", actions: [] });
    expect(document.querySelector(".error-page-actions")).toBeNull();
  });

  it("passes the click event to the handler so popovers can stop propagation", () => {
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

  it("renders the warning glyph only when one is asked for", () => {
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
  it("moves focus to the title so the new screen is announced", () => {
    showErrorPage({ title: "Your connection won't be verified" });
    const title = document.querySelector(".error-page-title");
    expect(document.activeElement).toBe(title);
  });

  it("keeps the title out of the tab sequence", () => {
    showErrorPage({ title: "t" });
    expect(
      document.querySelector(".error-page-title")?.getAttribute("tabindex"),
    ).toBe("-1");
  });
});

describe("showError shim", () => {
  it("forwards tips to the underlying page", () => {
    showError("t", "d", undefined, ["Check the cable."]);
    expect(
      document.querySelector(".error-page-tips-list li")?.textContent,
    ).toBe("Check the cable.");
  });

  it("wraps a bare function as a Retry action", () => {
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
