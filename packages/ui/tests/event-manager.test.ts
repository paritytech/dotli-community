// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { EventManager } from "@dotli/ui/event-manager";

describe("EventManager", () => {
  it("registers a listener that fires until disposed", () => {
    const events = new EventManager();
    const el = document.createElement("button");
    const handler = vi.fn();
    events.on(el, "click", handler);

    el.click();
    expect(handler).toHaveBeenCalledTimes(1);

    events.disposeAll();
    el.click();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("removes every registered listener on disposeAll", () => {
    const events = new EventManager();
    const a = vi.fn();
    const b = vi.fn();
    events.on(document, "click", a);
    events.on(document, "keydown", b);
    expect(events.size).toBe(2);

    events.disposeAll();
    document.dispatchEvent(new Event("click"));
    document.dispatchEvent(new Event("keydown"));
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(events.size).toBe(0);
  });

  it("returns a disposer from on() that removes just that listener", () => {
    const events = new EventManager();
    const el = document.createElement("div");
    const handler = vi.fn();
    const dispose = events.on(el, "click", handler);

    dispose();
    el.click();
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs arbitrary teardown callbacks added via add()", () => {
    const events = new EventManager();
    const teardown = vi.fn();
    events.add(teardown);
    events.disposeAll();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("is safe to dispose more than once (no double teardown)", () => {
    const events = new EventManager();
    const teardown = vi.fn();
    events.add(teardown);
    events.disposeAll();
    events.disposeAll();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("matches add/remove options so capture listeners are torn down", () => {
    const events = new EventManager();
    const el = document.createElement("div");
    const handler = vi.fn();
    events.on(el, "click", handler, { capture: true });
    events.disposeAll();
    el.click();
    expect(handler).not.toHaveBeenCalled();
  });
});
