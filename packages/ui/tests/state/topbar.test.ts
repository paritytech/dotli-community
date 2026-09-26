// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import {
  getTopbarState,
  setBlockingModalActive,
  recordChainsButtonVisible,
  setTopbarVisible,
  topbarStore,
} from "@dotli/ui/state/topbar";
import { resetStores, settle } from "../helpers/solid";

describe("topbar store", () => {
  afterEach(() => {
    resetStores();
  });

  it("As the shell, the topbar starts visible, unblocked, with the chains button hidden", () => {
    expect(getTopbarState()).toEqual({
      visible: true,
      blockingModalActive: false,
      chainsButtonVisible: false,
    });
  });

  it("As the chat panel, topbar:visibility still carries a boolean detail", async () => {
    // Given
    const details: unknown[] = [];
    const listener = (e: Event): void => {
      details.push((e as CustomEvent).detail);
    };
    window.addEventListener("topbar:visibility", listener);

    // When
    setTopbarVisible(false);
    await settle();

    // Then
    expect(details).toEqual([false]);
    expect(topbarStore.get().visible).toBe(false);
    window.removeEventListener("topbar:visibility", listener);
  });

  it("As the topbar, dotli:blocking-modal-active still carries { active }", () => {
    // Given
    const details: unknown[] = [];
    const listener = (e: Event): void => {
      details.push((e as CustomEvent).detail);
    };
    window.addEventListener("dotli:blocking-modal-active", listener);

    // When
    setBlockingModalActive(true);

    // Then
    expect(details).toEqual([{ active: true }]);
    expect(getTopbarState().blockingModalActive).toBe(true);
    window.removeEventListener("dotli:blocking-modal-active", listener);
  });

  it("As the host, chains button visibility is recorded without an event", () => {
    // When
    recordChainsButtonVisible(true);

    // Then
    expect(getTopbarState().chainsButtonVisible).toBe(true);
  });
});
