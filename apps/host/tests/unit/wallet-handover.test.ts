// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_TAKEOVER_WINDOW_MS,
  claimAutoTakeover,
  onNextInteraction,
} from "../../src/wallet-handover";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("automatic test-wallet takeover", () => {
  it("takes the wallet once, then falls back instead of reloading in a loop", () => {
    const storage = memoryStorage();

    expect(claimAutoTakeover(storage, 1_000)).toBe(true);
    // The reload after a takeover is refused again: the takeover did not stick.
    expect(
      claimAutoTakeover(storage, 1_000 + AUTO_TAKEOVER_WINDOW_MS - 1),
    ).toBe(false);
    // A later refusal is a new situation, so it may take over again.
    expect(claimAutoTakeover(storage, 1_000 + AUTO_TAKEOVER_WINDOW_MS)).toBe(
      true,
    );
  });

  it("never takes over automatically without per-tab storage", () => {
    const broken = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    };

    expect(claimAutoTakeover(broken)).toBe(false);
  });
});

describe("resuming a paused tab", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("resumes once on the first click or key press in the shell", () => {
    const resume = vi.fn();
    onNextInteraction(resume);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    window.dispatchEvent(new PointerEvent("pointerdown"));

    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("resumes when focus moves into the app frame", () => {
    vi.useFakeTimers();
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const resume = vi.fn();
    onNextInteraction(resume);

    frame.focus();
    window.dispatchEvent(new Event("blur"));
    vi.runAllTimers();

    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("ignores the window losing focus to another tab", () => {
    vi.useFakeTimers();
    const resume = vi.fn();
    onNextInteraction(resume);

    window.dispatchEvent(new Event("blur"));
    vi.runAllTimers();

    expect(resume).not.toHaveBeenCalled();
  });
});
