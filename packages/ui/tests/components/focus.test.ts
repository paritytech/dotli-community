// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  containTab,
  focusables,
  focusFirst,
  focusInto,
  lockScroll,
} from "../../src/components/focus.js";
import { query } from "../support.js";

function surface(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

function ids(els: Element[]): string[] {
  return els.map((el) => el.id);
}

function tab(target: HTMLElement, shiftKey = false): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    cancelable: true,
  });
  containTab(ev, target);
  return ev;
}

afterEach(() => {
  document.body.replaceChildren();
  document.body.removeAttribute("data-scroll-locked");
  vi.restoreAllMocks();
});

describe("focusables", () => {
  it("As a keyboard user, Tab reaches buttons, inputs, selects, textareas, links and tabindex elements in order", () => {
    // Given
    const root = surface(`
      <button id="b">b</button>
      <input id="i">
      <select id="s"><option>x</option></select>
      <textarea id="t"></textarea>
      <a id="a" href="#x">a</a>
      <div id="d" tabindex="0"></div>
    `);

    // Then
    expect(ids(focusables(root))).toEqual(["b", "i", "s", "t", "a", "d"]);
  });

  it("As a keyboard user, Tab skips disabled controls, anchors without href, tabindex -1 and unchecked radios", () => {
    // Given
    const root = surface(`
      <button id="off" disabled>b</button>
      <select id="soff" disabled></select>
      <textarea id="toff" disabled></textarea>
      <a id="nohref">a</a>
      <div id="minus" tabindex="-1"></div>
      <input id="r1" type="radio" name="g">
      <input id="r2" type="radio" name="g" checked>
      <button id="on">on</button>
    `);

    // Then
    expect(ids(focusables(root))).toEqual(["r2", "on"]);
  });

  it("As a keyboard user, Tab skips controls CSS hides", () => {
    // Given
    const root = surface(
      `<button id="shown"></button><button id="hidden"></button>`,
    );
    const hidden = query(root, "#hidden");
    hidden.checkVisibility = () => false;

    // Then
    expect(ids(focusables(root))).toEqual(["shown"]);
  });
});

describe("containTab", () => {
  it("As a keyboard user, Tab on the last control wraps to the first, and Shift+Tab on the first wraps to the last", () => {
    // Given
    const root = surface(
      `<button id="first"></button><select id="mid"></select><textarea id="last"></textarea>`,
    );
    const first = query(root, "#first");
    const last = query(root, "#last");

    // When
    last.focus();
    const forward = tab(root);

    // Then
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    // When
    const back = tab(root, true);

    // Then
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it("As a keyboard user, Tab between the ends is left to the browser", () => {
    // Given
    const root = surface(
      `<button id="first"></button><button id="mid"></button><button id="last"></button>`,
    );
    query(root, "#mid").focus();

    // Then
    expect(tab(root).defaultPrevented).toBe(false);
    expect(tab(root, true).defaultPrevented).toBe(false);
  });

  it("As a keyboard user, Tab from outside the surface comes back in, and Shift+Tab lands on the last control", () => {
    // Given
    const outside = surface(`<button id="out"></button>`);
    const root = surface(
      `<button id="first"></button><button id="last"></button>`,
    );

    // When
    (outside.firstElementChild as HTMLElement).focus();
    tab(root);

    // Then
    expect(document.activeElement?.id).toBe("first");

    // When
    (outside.firstElementChild as HTMLElement).focus();
    tab(root, true);

    // Then
    expect(document.activeElement?.id).toBe("last");
  });

  it("As a keyboard user, Tab in a surface with no controls keeps focus on the surface", () => {
    // Given
    const root = surface(`<p>text</p>`);
    root.tabIndex = -1;

    // When
    const ev = tab(root);

    // Then
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(root);
  });
});

describe("focusFirst and focusInto", () => {
  it("As a keyboard user, focus goes to the first candidate that takes it", () => {
    // Given
    const root = surface(
      `<button id="off" disabled></button><button id="on"></button>`,
    );

    // When
    const moved = focusFirst([...root.querySelectorAll("button")]);

    // Then
    expect(moved).toBe(true);
    expect(document.activeElement?.id).toBe("on");
    expect(focusFirst([])).toBe(false);
  });

  it("As a keyboard user, opening a surface focuses its first control, skipping links", () => {
    // Given
    const root = surface(
      `<a id="link" href="#x">link</a><select id="s"></select>`,
    );

    // When
    focusInto(root);

    // Then
    expect(document.activeElement?.id).toBe("s");
  });

  it("As a keyboard user, a surface with only links focuses itself when it has a tabindex, and nothing otherwise", () => {
    // Given
    const plain = surface(`<a href="#x">link</a>`);
    const focusable = surface(`<a href="#x">link</a>`);
    focusable.tabIndex = -1;

    // When
    focusInto(plain);

    // Then
    expect(document.activeElement).toBe(document.body);

    // When
    focusInto(focusable);

    // Then
    expect(document.activeElement).toBe(focusable);
  });

  it("As a keyboard user, explicit candidates replace the default ones", () => {
    // Given
    const root = surface(
      `<button id="b"></button><div id="item" tabindex="-1"></div>`,
    );
    root.tabIndex = -1;

    // When
    focusInto(root, [query(root, "#item")]);

    // Then
    expect(document.activeElement?.id).toBe("item");

    // When
    focusInto(root, []);

    // Then
    expect(document.activeElement).toBe(root);
  });
});

describe("lockScroll", () => {
  it("As a visitor, the page stays locked until the last lock is released, and a release twice counts once", () => {
    // Given
    const first = lockScroll();
    const second = lockScroll();

    // When
    first();
    first();

    // Then
    expect(document.body.hasAttribute("data-scroll-locked")).toBe(true);

    // When
    second();

    // Then
    expect(document.body.hasAttribute("data-scroll-locked")).toBe(false);
  });
});
