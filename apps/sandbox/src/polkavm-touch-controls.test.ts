// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installPolkaVmTouchControls,
  type PolkaVmTouchControls,
} from "./polkavm-touch-controls";

type Control =
  | "move"
  | "look"
  | "fire"
  | "grapple"
  | "jump"
  | "reload"
  | "start"
  | "run";
type PointerPhase =
  | "pointerdown"
  | "pointermove"
  | "pointerup"
  | "pointercancel"
  | "lostpointercapture";

interface TouchFixture {
  controls: PolkaVmTouchControls;
  keys: Set<string>;
  buttons: Set<number>;
  aim: { x: number; y: number };
  emissions: string[];
  pointer: (
    control: Control,
    type: PointerPhase,
    id: number,
    x?: number,
    y?: number,
  ) => void;
  holdAll: () => void;
  expectReleased: () => void;
}

let now: number;
let nextFrame: number;
let frames: Map<number, FrameRequestCallback>;
let dispose: (() => void) | undefined;

beforeEach(() => {
  now = 1_000;
  nextFrame = 0;
  frames = new Map();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function frame(elapsed: number): void {
  now += elapsed;
  for (const [id, callback] of [...frames]) {
    if (frames.delete(id)) {
      callback(now);
    }
  }
}

function fixture(): TouchFixture {
  const surface = document.createElement("div");
  document.body.appendChild(surface);
  const keys = new Set<string>();
  const buttons = new Set<number>();
  const aim = { x: 0, y: 0 };
  const emissions: string[] = [];
  const controls = installPolkaVmTouchControls(surface, {
    activate: () => {
      emissions.push("activate");
    },
    key: (code, down) => {
      if (down) {
        keys.add(code);
      } else {
        keys.delete(code);
      }
      emissions.push(`key:${code}:${String(down)}`);
    },
    button: (button, down) => {
      if (down) {
        buttons.add(button);
      } else {
        buttons.delete(button);
      }
      emissions.push(`button:${String(button)}:${String(down)}`);
    },
    look: (x, y) => {
      aim.x += x;
      aim.y += y;
      emissions.push("look");
    },
  });
  dispose = controls.cleanup;
  const targets = new Map<string, HTMLElement>();
  const captures = new Map<HTMLElement, Set<number>>();
  for (const target of surface.querySelectorAll<HTMLElement>(
    "[data-touch-control]",
  )) {
    const name = target.dataset.touchControl;
    if (name === undefined) {
      throw new Error("Control has no input identity");
    }
    targets.set(name, target);
    const held = new Set<number>();
    captures.set(target, held);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 200, 200),
    );
    Object.defineProperties(target, {
      setPointerCapture: {
        configurable: true,
        value: (id: number) => {
          held.add(id);
        },
      },
      hasPointerCapture: {
        configurable: true,
        value: (id: number) => held.has(id),
      },
      releasePointerCapture: {
        configurable: true,
        value: (id: number) => {
          held.delete(id);
        },
      },
    });
  }
  function pointer(
    control: Control,
    type: PointerPhase,
    id: number,
    x = 100,
    y = 100,
  ): void {
    const target = targets.get(control);
    if (!target) {
      throw new Error(`Missing touch control: ${control}`);
    }
    const held = captures.get(target);
    if (held === undefined) {
      throw new Error(`Missing pointer capture state: ${control}`);
    }
    const captured = held.has(id);
    if (type === "lostpointercapture") {
      held.delete(id);
    }
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: id,
        pointerType: "touch",
        button: 0,
        buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
        clientX: x,
        clientY: y,
      }),
    );
    // Browsers implicitly release capture after pointerup, even if the handler
    // already released it. That notification must not cancel other contacts.
    if (type === "pointerup" && captured) {
      pointer(control, "lostpointercapture", id, x, y);
    }
  }
  function holdAll(): void {
    const previousAim = aim.x;
    pointer("move", "pointerdown", 1, 160, 40);
    pointer("look", "pointerdown", 2, 160, 100);
    pointer("fire", "pointerdown", 3);
    pointer("run", "pointerdown", 4);
    frame(0);
    frame(20);
    expect(keys).toEqual(new Set(["KeyW", "KeyD", "ShiftLeft"]));
    expect(buttons).toEqual(new Set([1]));
    expect(aim.x).toBeGreaterThan(previousAim);
  }
  function expectReleased(): void {
    expect(keys).toEqual(new Set());
    expect(buttons).toEqual(new Set());
    const before = [...emissions];
    frame(20);
    frame(60_000);
    expect(emissions).toEqual(before);
    expect(frames.size).toBe(0);
  }
  return {
    controls,
    keys,
    buttons,
    aim,
    emissions,
    pointer,
    holdAll,
    expectReleased,
  };
}

describe("PolkaVM touch controls", () => {
  it("keeps movement, continuous aiming, and fire independent across pointer releases", () => {
    const state = fixture();
    state.controls.setEnabled(true);
    state.holdAll();
    state.controls.setEnabled(true);

    state.pointer("move", "pointermove", 1, 101, 99);
    expect(state.keys).toEqual(new Set(["ShiftLeft"]));
    const firstAim = state.aim.x;
    frame(20);
    expect(state.aim.x).toBeGreaterThan(firstAim);
    expect(state.buttons).toEqual(new Set([1]));

    state.pointer("move", "pointermove", 1, 40, 160);
    expect(state.keys).toEqual(new Set(["ShiftLeft", "KeyA", "KeyS"]));
    state.pointer("fire", "pointerup", 3);
    expect(state.buttons).toEqual(new Set());
    expect(state.keys).toEqual(new Set(["ShiftLeft", "KeyA", "KeyS"]));
    const beforeRelease = state.aim.x;
    frame(20);
    expect(state.aim.x).toBeGreaterThan(beforeRelease);

    state.pointer("look", "pointermove", 2);
    const centeredAim = { ...state.aim };
    frame(100);
    expect(state.aim).toEqual(centeredAim);
    state.pointer("move", "pointerup", 1);
    state.pointer("look", "pointerup", 2);
    state.pointer("run", "pointerup", 4);
    state.expectReleased();
  });

  it("holds a shared key and fire until their final contact ends", () => {
    const state = fixture();
    state.controls.setEnabled(true);
    state.pointer("fire", "pointerdown", 11);
    state.pointer("fire", "pointerdown", 12);
    state.pointer("run", "pointerdown", 21);
    state.pointer("run", "pointerdown", 22);
    state.pointer("fire", "pointerup", 11);
    state.pointer("run", "pointerup", 21);
    expect(state.buttons).toEqual(new Set([1]));
    expect(state.keys).toEqual(new Set(["ShiftLeft"]));
    state.pointer("fire", "pointerup", 12);
    expect(state.buttons).toEqual(new Set());
    expect(state.keys).toEqual(new Set(["ShiftLeft"]));
    state.pointer("run", "pointerup", 22);
    state.expectReleased();
  });

  it.each(["pointercancel", "lostpointercapture"] as const)(
    "%s releases only the interrupted contact",
    (cause) => {
      const state = fixture();
      state.controls.setEnabled(true);
      state.holdAll();
      state.pointer("fire", cause, 3);
      expect(state.buttons).toEqual(new Set());
      expect(state.keys).toEqual(new Set(["KeyW", "KeyD", "ShiftLeft"]));
      const aim = state.aim.x;
      frame(20);
      expect(state.aim.x).toBeGreaterThan(aim);
      state.pointer("look", cause, 2);
      const stoppedAim = state.aim.x;
      frame(20);
      expect(state.aim.x).toBe(stoppedAim);
      state.controls.setEnabled(false);
      state.expectReleased();
      const released = [...state.emissions];
      state.pointer("move", "pointermove", 1, 40, 160);
      state.pointer("look", "pointermove", 2, 160, 100);
      state.pointer("run", "pointerup", 4);
      frame(20);
      expect(state.emissions).toEqual(released);
    },
  );

  it("releases on resize and backgrounding, without resuming stale contacts", () => {
    const state = fixture();
    state.controls.setEnabled(true);
    state.holdAll();
    window.dispatchEvent(new Event("resize"));
    state.expectReleased();

    state.holdAll();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    state.expectReleased();
    const backgrounded = [...state.emissions];
    state.pointer("fire", "pointerdown", 30);
    expect(state.emissions).toEqual(backgrounded);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    state.pointer("look", "pointermove", 2, 180, 100);
    frame(20);
    expect(state.emissions).toEqual(backgrounded);
  });

  it("ignores disabled input and leaves no callbacks after reset or cleanup", () => {
    const state = fixture();
    state.pointer("fire", "pointerdown", 3);
    expect(state.emissions).toEqual([]);
    state.controls.setEnabled(true);
    state.holdAll();
    state.controls.reset();
    state.expectReleased();
    const reset = [...state.emissions];
    state.pointer("look", "pointermove", 2, 180, 100);
    state.pointer("fire", "pointerup", 3);
    frame(20);
    expect(state.emissions).toEqual(reset);

    state.holdAll();
    state.controls.cleanup();
    state.expectReleased();
    const cleaned = [...state.emissions];
    state.pointer("fire", "pointerdown", 40);
    state.pointer("look", "pointerdown", 41, 180, 100);
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("pagehide"));
    state.controls.reset();
    state.controls.cleanup();
    frame(20);
    expect(state.emissions).toEqual(cleaned);
  });

  it("integrates look by elapsed time and bounds a suspended frame", () => {
    const state = fixture();
    state.controls.setEnabled(true);
    function distance(step: number): number {
      state.controls.reset();
      const start = state.aim.x;
      state.pointer("look", "pointerdown", 2, 160, 100);
      frame(0);
      for (let elapsed = 0; elapsed < 1_000; elapsed += step) {
        frame(step);
      }
      return state.aim.x - start;
    }
    const fast = distance(10);
    const slow = distance(20);
    expect(fast).toBeGreaterThan(0);
    // Allow at most a pixel of accumulated rounding, not a frame-rate multiplier.
    expect(Math.abs(slow - fast)).toBeLessThanOrEqual(1);
    expect(state.aim.y).toBe(0);
    const beforePause = state.aim.x;
    frame(60_000);
    const resumed = state.aim.x - beforePause;
    expect(resumed).toBeGreaterThan(0);
    expect(resumed).toBeLessThan(slow);
    state.pointer("look", "pointerup", 2);
    state.expectReleased();
  });
});
