// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page (components/landing/Landing.tsx), mounted as the loader
// mounts it: the name form, the typing placeholder, the recently visited
// pills, and the auth and theme controls it moves into its corner.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush } from "solid-js";
import { escapeHtml } from "@dotli/shared";
import { getActiveTldSuffix, withActiveTld } from "@dotli/config";
import { mountLandingPage } from "../../helpers/landing.js";
import { byId, query, must } from "../../support.js";
import { nth } from "../../helpers/nth.js";

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("../../../../metrics/src/sentry.js", () => sentry);

const recents = vi.hoisted(() => ({
  labels: [] as string[],
  forget: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../src/recent-labels.js", () => ({
  loadRecentLabels: () => Promise.resolve([...recents.labels]),
  forgetRecentLabel: recents.forget,
}));

const SUFFIX = getActiveTldSuffix();

/**
 * The landing page as ui.ts rendered it at 17bb7a79 (the `app.innerHTML`
 * write of `showLanding`), left as that function left it: the typing
 * placeholder had already replaced the placeholder with "browse".
 */
function oldLandingMarkup(): Element {
  const template = document.createElement("template");
  template.innerHTML = `
    <div class="landing">
      <div class="landing-auth" id="landing-auth"></div>
      <div class="landing-center">
      <div class="landing-content">
        <div class="landing-logo">
          <svg width="48" height="54" viewBox="0 0 16 18" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M9.9873 14.1348C10.8273 14.1348 11.462 14.3911 11.6113 14.8604C11.8447 15.6051 10.7691 16.609 9.20801 17.1016C7.64706 17.5964 6.1908 17.3912 5.95508 16.6465C5.7363 15.9482 6.6685 15.0218 8.07227 14.5029L8.3584 14.4023C8.93466 14.2203 9.49501 14.1348 9.9873 14.1348ZM2.23828 9.9248C2.99193 9.9248 3.82268 10.226 4.52734 10.8213C5.85738 11.9442 6.23288 13.6886 5.36719 14.7158C4.50142 15.7428 2.71861 15.6629 1.38867 14.54C0.100568 13.4522 -0.291878 11.7823 0.47168 10.7451L0.551758 10.6465C0.957761 10.1634 1.5687 9.92482 2.23828 9.9248ZM15.1748 9.47949C15.2096 9.4795 15.2397 9.48415 15.2676 9.49805C15.6409 9.67081 15.4174 10.9618 14.7617 12.3789C14.1085 13.7956 13.2732 14.8041 12.8975 14.6318C12.5218 14.4591 12.7481 13.168 13.4014 11.751C14.0057 10.4413 14.7665 9.47949 15.1748 9.47949ZM3.42578 2.46387C3.9998 2.46387 4.55096 2.64366 4.9873 3.01953C6.10236 3.97675 6.07202 5.84169 4.92188 7.18164C3.76917 8.52404 1.93275 8.83452 0.817383 7.875C-0.297896 6.91782 -0.267461 5.05292 0.882812 3.71289C1.58276 2.8982 2.5345 2.46396 3.42578 2.46387ZM13.1631 2.80957C13.6391 2.80957 14.4071 3.79925 14.9531 5.15332C15.5458 6.62173 15.6526 7.96206 15.1953 8.14648C14.7355 8.33003 13.8845 7.29114 13.292 5.82324C12.6993 4.35719 12.5892 3.01463 13.0488 2.83008C13.0861 2.8161 13.1235 2.8096 13.1631 2.80957ZM7.82422 0C8.30483 0 8.83683 0.0896562 9.37109 0.276367C10.9576 0.829603 11.9799 2.02888 11.6582 2.95801C11.3362 3.88718 9.78886 4.19295 8.20215 3.63965C6.61582 3.08633 5.5943 1.88706 5.91602 0.958008C6.12834 0.341726 6.87931 6.04412e-05 7.82422 0Z" fill="currentColor"/>
          </svg>
        </div>
        <h1 class="landing-title">Polkadot Web</h1>
        <p class="landing-subtitle">The decentralized web, in your browser.</p>
        <form id="dotli-nav-form" class="landing-nav-form" autocomplete="off">
          <div class="landing-search-bar" id="dotli-nav-bar">
            <input id="dotli-nav-input" class="landing-search-input" type="text" placeholder="${escapeHtml(withActiveTld("browse"))}" spellcheck="false" autocomplete="off" aria-label="Search a ${escapeHtml(SUFFIX)} name" aria-describedby="dotli-nav-error" />
            <span class="landing-dot-label">${escapeHtml(SUFFIX)}</span>
            <button type="submit" class="landing-go-btn" aria-label="Go">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </button>
          </div>
          <p id="dotli-nav-error" class="landing-nav-error" role="alert" hidden></p>
        </form>
        <div id="dotli-recent" class="landing-recent" hidden></div>
      </div>
      </div>
    </div>
  `;
  const landing = must(
    template.content.firstElementChild,
    "the landing markup",
  );
  query(landing, "#dotli-nav-input", HTMLInputElement).placeholder = "browse";
  return landing;
}

/**
 * One recently visited pill as ui.ts rendered it at 17bb7a79
 * (`renderRecentPills`), on localhost port 5173.
 */
function oldPillMarkup(label: string): Element {
  const safe = escapeHtml(label);
  const template = document.createElement("template");
  template.innerHTML = `<span class="landing-recent-item" data-label="${safe}">
        <a href="${escapeHtml(`http://${label}.localhost:5173`)}" class="landing-recent-pill">
          <span class="landing-recent-label">${safe}<span class="landing-tld">${escapeHtml(SUFFIX)}</span></span>
        </a>
        <button type="button" class="landing-recent-remove" aria-label="Remove ${safe}${escapeHtml(SUFFIX)} from recently visited" title="Remove">
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>
        </button>
      </span>`;
  return must(template.content.firstElementChild, "the recent item markup");
}

/**
 * `node` as tag, attributes (sorted) and children, without comments and
 * whitespace-only text, so template-literal and JSX markup compare node for
 * node.
 */
function shape(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").trim();
  }
  if (!(node instanceof Element)) {
    return "";
  }
  const attrs = [...node.attributes]
    .map((a) => `${a.name}="${a.value}"`)
    .sort()
    .join(" ");
  const children = [...node.childNodes]
    .map(shape)
    .filter((s) => s !== "")
    .join("");
  return `<${node.tagName.toLowerCase()} ${attrs}>${children}</>`;
}

let reducedMotion = false;
let page: ReturnType<typeof mountLandingPage> | null = null;

function mount(): ReturnType<typeof mountLandingPage> {
  page = mountLandingPage();
  return page;
}

/** Let the recents load and render. */
async function settle(): Promise<void> {
  flush();
  await Promise.resolve();
  await Promise.resolve();
  flush();
}

function type(value: string): void {
  const input = byId("dotli-nav-input", HTMLInputElement);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function submit(): Event {
  const event = new Event("submit", { bubbles: true, cancelable: true });
  byId("dotli-nav-form").dispatchEvent(event);
  return event;
}

function items(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".landing-recent-item")];
}

function touch(target: Element, kind: string): void {
  target.dispatchEvent(new Event(kind, { bubbles: true }));
}

function click(target: Element): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  reducedMotion = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)" && reducedMotion,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal("location", {
    hostname: "localhost",
    protocol: "http:",
    port: "5173",
    href: "http://localhost:5173/",
  });
  recents.labels = [];
  recents.forget.mockClear();
  sentry.captureException.mockClear();
  document.body.innerHTML = "";
});

afterEach(() => {
  page?.dispose();
  page = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("landing page", () => {
  it("As a visitor, the landing page has the same markup as before", async () => {
    // When
    const { view } = mount();
    await settle();

    // Then
    expect(view.children).toHaveLength(1);
    expect(shape(nth(view.children, 0))).toBe(shape(oldLandingMarkup()));
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("As a visitor, nothing is focused when the page loads, so a screen reader starts at the top and no keyboard pops up", async () => {
    // When
    mount();
    await settle();

    // Then
    expect(document.activeElement).toBe(document.body);
  });

  it("As a visitor who types an invalid name, I see why inline and stay on the page, and the error clears when I type again", async () => {
    // Given
    mount();
    await settle();

    // When
    type("Bad Name");
    const event = submit();
    await settle();

    // Then
    const input = byId("dotli-nav-input", HTMLInputElement);
    const error = byId("dotli-nav-error");
    expect(event.defaultPrevented).toBe(true);
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(
      "Names can only contain a-z, 0-9 and hyphens",
    );
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(
      byId("dotli-nav-bar").classList.contains("landing-search-bar--error"),
    ).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(window.location.href).toBe("http://localhost:5173/");

    // When
    type("bad");
    await settle();

    // Then
    expect(error.hidden).toBe(true);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(
      byId("dotli-nav-bar").classList.contains("landing-search-bar--error"),
    ).toBe(false);
  });

  it("As a visitor who submits nothing, I am asked for a name", async () => {
    // Given
    mount();
    await settle();

    // When
    submit();
    await settle();

    // Then
    expect(byId("dotli-nav-error").textContent).toBe("Enter a name to browse");
  });

  it("As a visitor who types a valid name, with or without the TLD, I am taken to its site", async () => {
    // Given
    mount();
    await settle();

    // When
    type(`  Mark3t${SUFFIX} `);
    submit();

    // Then
    expect(window.location.href).toBe("http://mark3t.localhost:5173");
    expect(byId("dotli-nav-error").hidden).toBe(true);
  });

  it("As a visitor on the live site, a valid name takes me to its subdomain of the base domain", async () => {
    // Given
    vi.stubGlobal("location", { hostname: "dot.li", href: "https://dot.li/" });
    mount();
    await settle();

    // When
    type("playground");
    submit();

    // Then
    expect(window.location.href).toMatch(/^https:\/\/playground\.[^/]+$/);
  });

  it("As a visitor, the input's first placeholder is the first example name, without the suffix", async () => {
    // Given: what the input showed each time the typing placeholder wrote it.
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "placeholder",
    );
    if (descriptor?.set === undefined) {
      throw new Error("expected a placeholder setter");
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the native setter is called with the input as its receiver below.
    const setter = descriptor.set;
    const shown: (string | null)[] = [];
    const spy = vi
      .spyOn(HTMLInputElement.prototype, "placeholder", "set")
      .mockImplementation(function (this: HTMLInputElement, value: string) {
        shown.push(this.getAttribute("placeholder"));
        setter.call(this, value);
      });

    // When
    mount();
    await settle();
    spy.mockRestore();

    // Then: the suffix never showed in the input; it is the label beside it.
    expect(shown.length).toBeGreaterThan(0);
    expect(shown[0]).toBe("browse");
    expect(byId("dotli-nav-input", HTMLInputElement).placeholder).toBe(
      "browse",
    );
  });

  it("As a visitor, the placeholder types example names in turn, pauses while I type, and stops when the page goes", async () => {
    // Given
    mount();
    await settle();
    const input = byId("dotli-nav-input", HTMLInputElement);
    expect(input.placeholder).toBe("browse");

    // When: the hold ends, then one character is erased.
    vi.advanceTimersByTime(1400);
    vi.advanceTimersByTime(45);

    // Then
    expect(input.placeholder).toBe("brows");

    // When: the rest is erased and the next name typed.
    vi.advanceTimersByTime(45 * 5 + 95 * 6);

    // Then
    expect(input.placeholder).toBe("mark3t");

    // When: the visitor types, the cycle pauses.
    type("x");
    vi.advanceTimersByTime(10_000);

    // Then
    expect(input.placeholder).toBe("mark3t");
    expect(vi.getTimerCount()).toBe(0);

    // When: clearing the input resumes it.
    type("");
    vi.advanceTimersByTime(95);

    // Then
    expect(vi.getTimerCount()).toBe(1);

    // When
    page?.dispose();
    page = null;

    // Then
    expect(vi.getTimerCount()).toBe(0);
  });

  it("As a visitor who prefers reduced motion, the placeholder shows one name and stays still", async () => {
    // Given
    reducedMotion = true;

    // When
    mount();
    await settle();

    // Then
    expect(byId("dotli-nav-input", HTMLInputElement).placeholder).toBe(
      "browse",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("As a returning visitor, my recently visited names show as pills linking to their sites", async () => {
    // Given
    recents.labels = ["alpha", "beta"];

    // When
    mount();
    await settle();

    // Then
    const recent = byId("dotli-recent");
    expect(recent.hidden).toBe(false);
    expect(recent.children).toHaveLength(1);
    expect(recent.children[0]?.className).toBe("landing-recent-list");
    expect(items().map((item) => item.dataset["label"])).toEqual([
      "alpha",
      "beta",
    ]);
    expect(items().map(shape)).toEqual(
      ["alpha", "beta"].map((label) => shape(oldPillMarkup(label))),
    );
    const pill = nth(items(), 0).querySelector<HTMLAnchorElement>(
      "a.landing-recent-pill",
    );
    expect(pill?.getAttribute("href")).toBe("http://alpha.localhost:5173");
    expect(pill?.textContent).toBe(`alpha${SUFFIX}`);
    expect(
      pill?.querySelector(".landing-recent-label > .landing-tld")?.textContent,
    ).toBe(SUFFIX);
    const remove = nth(items(), 0).querySelector(
      "button.landing-recent-remove",
    );
    expect(remove?.getAttribute("type")).toBe("button");
    expect(remove?.getAttribute("aria-label")).toBe(
      `Remove alpha${SUFFIX} from recently visited`,
    );
    expect(remove?.getAttribute("title")).toBe("Remove");
    expect(remove?.querySelectorAll("svg line")).toHaveLength(2);
  });

  it("As a visitor with no recently visited names, no recents row shows", async () => {
    // When
    mount();
    await settle();

    // Then
    expect(byId("dotli-recent").hidden).toBe(true);
    expect(byId("dotli-recent").children).toHaveLength(0);
  });

  it("As a visitor, a recent name that holds markup shows as text", async () => {
    // Given
    const hostile = `<img src=x onerror="alert(1)">`;
    recents.labels = [hostile];

    // When
    mount();
    await settle();

    // Then
    expect(document.querySelector("img")).toBeNull();
    expect(items()[0]?.dataset["label"]).toBe(hostile);
    expect(
      items()[0]?.querySelector(".landing-recent-label")?.firstChild
        ?.textContent,
    ).toBe(hostile);
  });

  it("As a returning visitor, the remove button forgets a name, and the row goes once none is left", async () => {
    // Given
    recents.labels = ["alpha", "beta"];
    mount();
    await settle();

    // When
    const event = click(
      query(nth(items(), 0), ".landing-recent-remove", Element),
    );
    await settle();

    // Then
    expect(event.defaultPrevented).toBe(true);
    expect(recents.forget).toHaveBeenCalledWith("alpha");
    expect(items().map((item) => item.dataset["label"])).toEqual(["beta"]);
    expect(byId("dotli-recent").hidden).toBe(false);

    // When
    click(query(nth(items(), 0), ".landing-recent-remove svg", Element));
    await settle();

    // Then
    expect(recents.forget).toHaveBeenLastCalledWith("beta");
    expect(items()).toHaveLength(0);
    expect(byId("dotli-recent").hidden).toBe(true);
    expect(byId("dotli-recent").children).toHaveLength(0);
  });

  it("As a touch visitor, a long press on a pill reveals its remove button instead of navigating, and a tap elsewhere hides it", async () => {
    // Given
    recents.labels = ["alpha", "beta"];
    mount();
    await settle();
    const alpha = nth(items(), 0);
    const beta = nth(items(), 1);
    const alphaPill = query(alpha, ".landing-recent-pill", Element);

    // When: a press that moves is a scroll, not a long press.
    touch(alphaPill, "touchstart");
    vi.advanceTimersByTime(200);
    touch(alphaPill, "touchmove");
    vi.advanceTimersByTime(1000);
    await settle();

    // Then
    expect(alpha.classList.contains("is-removable")).toBe(false);

    // When
    touch(alphaPill, "touchstart");
    vi.advanceTimersByTime(449);
    await settle();

    // Then
    expect(alpha.classList.contains("is-removable")).toBe(false);

    // When
    vi.advanceTimersByTime(1);
    await settle();

    // Then
    expect(alpha.classList.contains("is-removable")).toBe(true);

    // When: the tap that ends the press does not navigate.
    touch(alphaPill, "touchend");
    const tap = click(alphaPill);

    // Then
    expect(tap.defaultPrevented).toBe(true);

    // When: a long press on another pill moves the reveal there.
    const betaPill = query(beta, ".landing-recent-pill", Element);
    touch(betaPill, "touchstart");
    vi.advanceTimersByTime(450);
    await settle();

    // Then
    expect(alpha.classList.contains("is-removable")).toBe(false);
    expect(beta.classList.contains("is-removable")).toBe(true);

    // When: a tap inside the recents keeps it.
    beta.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await settle();

    // Then
    expect(beta.classList.contains("is-removable")).toBe(true);

    // When: a tap anywhere else hides it.
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await settle();

    // Then
    expect(beta.classList.contains("is-removable")).toBe(false);
    expect(click(betaPill).defaultPrevented).toBe(false);
  });

  it("As a visitor, the page's document listener goes with it", async () => {
    // Given
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    recents.labels = ["alpha"];
    mount();
    await settle();
    const added = add.mock.calls.filter(([type]) => type === "pointerdown");
    expect(added).toHaveLength(1);

    // When
    page?.dispose();
    page = null;

    // Then
    expect(remove).toHaveBeenCalledWith("pointerdown", added[0]?.[1]);
  });

  it("As a visitor, the auth and theme controls move from the topbar into the page's corner", async () => {
    // Given
    document.body.innerHTML = `<div id="topbar"><button id="auth-button"></button><button id="theme-toggle"></button><div id="theme-popover"></div></div>`;
    const nodes = ["auth-button", "theme-toggle", "theme-popover"].map((id) =>
      byId(id),
    );

    // When
    mount();
    await settle();

    // Then
    const corner = byId("landing-auth");
    expect([...corner.children]).toEqual(nodes);
    expect(byId("topbar").children).toHaveLength(0);
  });

  it("As a visitor, a page without the auth button leaves the theme controls where they are, as before", async () => {
    // Given
    document.body.innerHTML = `<div id="topbar"><button id="theme-toggle"></button><div id="theme-popover"></div></div>`;

    // When
    mount();
    await settle();

    // Then
    expect(byId("landing-auth").children).toHaveLength(0);
    expect(byId("topbar").children).toHaveLength(2);
  });
});
