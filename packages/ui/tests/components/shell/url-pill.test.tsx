// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import { UrlPill } from "@dotli/ui/components/shell/UrlPill";
import {
  resetUrlPill,
  setVerificationShieldState,
  showLocalhostPill,
  showProductPill,
  urlPillStore,
} from "@dotli/ui/state/url-pill";
import { setVerificationShieldState as setShieldStateReexport } from "@dotli/ui/verification-shield";
import { renderComponent, resetStores, settle } from "../../helpers/solid";
import { byId, must } from "../../support";

// The markup main.ts wrote into `#topbar-url` before the pill became a
// component (its three `urlBar.innerHTML = ...` writes and
// verificationShieldMarkup()), with the product strings as placeholders.
const LOCALHOST_PILL = `<div class="topbar-url-pill localhost-pill" id="url-pill"><svg class="localhost-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg><span class="topbar-url-text"><span class="dot-domain">HOST</span></span></div>`;
const SHIELD = `<div class="verification-shield-wrap"><button type="button" id="verification-shield" class="verification-shield" aria-label="How was this site loaded?" aria-expanded="false" aria-controls="verification-tooltip"><svg class="verification-shield-icon is-verified" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true" focusable="false"><path d="M12 2L3 7v5c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5zm-1 14.59l-3.29-3.3 1.41-1.41L11 13.76l4.88-4.88 1.41 1.41L11 16.59z"/></svg><svg class="verification-shield-icon is-trusted" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true" focusable="false"><path d="M12 2L3 7v5c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5zM11 7.5h2v6h-2zM11 15.5h2v2h-2z"/></svg></button><div class="verification-tooltip" id="verification-tooltip"><div class="verification-tooltip-title">How was this site loaded?</div><div class="verification-tooltip-row" data-state="verified"><svg class="verification-tooltip-icon is-verified" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true" focusable="false"><path d="M12 2L3 7v5c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5zm-1 14.59l-3.29-3.3 1.41-1.41L11 13.76l4.88-4.88 1.41 1.41L11 16.59z"/></svg><span class="verification-tooltip-text"><span class="verification-tooltip-name"><strong class="verification-tooltip-label">Verified</strong><span class="verification-tooltip-current">This site</span></span><span class="verification-tooltip-desc">More secure, checked by your light client.</span></span></div><div class="verification-tooltip-row" data-state="trusted"><svg class="verification-tooltip-icon is-trusted" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true" focusable="false"><path d="M12 2L3 7v5c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5zM11 7.5h2v6h-2zM11 15.5h2v2h-2z"/></svg><span class="verification-tooltip-text"><span class="verification-tooltip-name"><strong class="verification-tooltip-label">Trusted</strong><span class="verification-tooltip-current">This site</span></span><span class="verification-tooltip-desc">Served by an external RPC provider.</span></span></div></div></div>`;
const PRODUCT_PILL = `<div class="topbar-url-pill" id="url-pill">${SHIELD}<span class="topbar-url-text"><span class="dot-domain">DOMAIN</span><span class="dot-tld">TLD</span></span></div>`;

afterEach(() => {
  resetStores();
});

function urlBar(): HTMLElement {
  return byId("topbar-url");
}

function pill(): HTMLElement | null {
  return document.getElementById("url-pill");
}

/** An element parsed from `html`, to compare with isEqualNode. */
function parse(html: string): Element {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  return must(holder.firstElementChild, "the parsed element");
}

describe("URL pill", () => {
  it("As a visitor on the landing page, the URL bar is the empty `#topbar-url` the shell prerenders, hidden by `:empty`", async () => {
    // When
    renderComponent(() => <UrlPill />);
    await settle();

    // Then
    expect(urlBar().childNodes).toHaveLength(0);
    expect(urlBar().matches(":empty")).toBe(true);
    expect(
      urlBar().isEqualNode(
        parse(`<div class="topbar-url" id="topbar-url"></div>`),
      ),
    ).toBe(true);
  });

  it("As a developer on a localhost proxy, the pill shows my host with the terminal icon, as before", async () => {
    // Given
    renderComponent(() => <UrlPill />);

    // When
    showLocalhostPill("localhost:3000");
    await settle();

    // Then
    expect(
      pill()?.isEqualNode(
        parse(LOCALHOST_PILL.replace("HOST", "localhost:3000")),
      ),
    ).toBe(true);
  });

  it("As a visitor of a product, the pill shows its domain and TLD beside the shield, as before", async () => {
    // Given
    renderComponent(() => <UrlPill />);

    // When
    showProductPill("app", ".dot.li");
    await settle();

    // Then
    expect(
      pill()?.isEqualNode(
        parse(PRODUCT_PILL.replace("DOMAIN", "app").replace("TLD", ".dot.li")),
      ),
    ).toBe(true);
  });

  it("As a dotli user, a domain or host containing markup renders as text", async () => {
    // Given
    renderComponent(() => <UrlPill />);

    // When
    showProductPill("<b>x</b>", "<i>y</i>");
    await settle();

    // Then
    expect(pill()?.querySelector("b")).toBeNull();
    expect(pill()?.querySelector("i")).toBeNull();
    expect(pill()?.querySelector(".dot-domain")?.textContent).toBe("<b>x</b>");
    expect(pill()?.querySelector(".dot-tld")?.textContent).toBe("<i>y</i>");

    // When
    showLocalhostPill("<b>x</b>");
    await settle();

    // Then
    expect(pill()?.querySelector("b")).toBeNull();
    expect(pill()?.querySelector(".dot-domain")?.textContent).toBe("<b>x</b>");
  });

  it("As a dotli user, a pill written before the component mounts shows on mount", async () => {
    // Given: main.ts resolved the product before the islands chunk arrived.
    showProductPill("app", ".dot.li");
    setVerificationShieldState("verified");

    // When
    renderComponent(() => <UrlPill />);
    await settle();

    // Then
    expect(pill()?.querySelector(".dot-domain")?.textContent).toBe("app");
    expect(
      document
        .getElementById("verification-shield")
        ?.classList.contains("verified"),
    ).toBe(true);
  });

  it("As a dotli user, resetting the pill empties the URL bar again", async () => {
    // Given
    renderComponent(() => <UrlPill />);
    showLocalhostPill("localhost:3000");
    await settle();

    // When
    resetUrlPill();
    await settle();

    // Then
    expect(urlBar().childNodes).toHaveLength(0);
    expect(urlPillStore.get()).toEqual({ kind: "none" });
  });

  it("As the host, a shield state set outside a product pill is ignored, and a new product pill starts without one", () => {
    // When
    setVerificationShieldState("verified");

    // Then
    expect(urlPillStore.get()).toEqual({ kind: "none" });

    // When
    showLocalhostPill("localhost:3000");
    setVerificationShieldState("verified");

    // Then
    expect(urlPillStore.get()).toEqual({
      kind: "localhost",
      host: "localhost:3000",
    });

    // When
    showProductPill("app", ".dot.li");
    setShieldStateReexport("trusted");
    showProductPill("other", ".dot.li");

    // Then
    expect(urlPillStore.get()).toEqual({
      kind: "product",
      domain: "other",
      tld: ".dot.li",
      shield: null,
    });
  });
});
