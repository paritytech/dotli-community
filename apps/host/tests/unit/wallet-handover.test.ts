// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import { WALLET_OWNER_BUSY_ERROR } from "@dotli/protocol/wallet-owner";
import { describeError, ERROR_TITLES } from "../../src/errors";
import { onNextInteraction } from "../../src/wallet-handover";

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

  it("resumes on a click into the app frame that had focus when the tab paused", () => {
    vi.useFakeTimers();
    const frame = document.createElement("iframe");
    document.body.append(frame);
    frame.focus();
    const resume = vi.fn();
    onNextInteraction(resume);

    // Switching away while paused is not an interaction.
    window.dispatchEvent(new Event("blur"));
    vi.runAllTimers();
    expect(resume).not.toHaveBeenCalled();

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

describe("test wallet held by an unresponsive tab", () => {
  it("is not reported as an unreachable domain with connectivity advice", () => {
    // Shaped as it arrives over postMessage: only message and name survive.
    const refused = new Error("The test wallet is in use in another tab.");
    refused.name = WALLET_OWNER_BUSY_ERROR;

    for (const isP2p of [true, false]) {
      expect(describeError(refused, isP2p)).toMatchObject({
        kind: "wallet-in-other-tab",
        title: ERROR_TITLES.WALLET_IN_OTHER_TAB,
        recovery: "reload",
        tips: [],
      });
    }
  });
});
