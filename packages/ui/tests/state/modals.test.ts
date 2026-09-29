// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import {
  failAllModals,
  modalsStore,
  openModal,
  resetModalsForTests,
  settleModal,
  type ModalView,
} from "../../src/state/modals.js";
import { nth } from "../helpers/nth.js";

type Choice = "yes" | "no" | "dismissed";

function view(title: string): ModalView<Choice> {
  return {
    title,
    fields: [],
    buttons: [
      { label: "No", variant: "cancel", result: "no" },
      { label: "Yes", variant: "primary", result: "yes" },
    ],
    dismissOnBackdrop: true,
    dismissResult: "dismissed",
    fallbackResult: "dismissed",
  };
}

afterEach(() => {
  resetModalsForTests();
});

describe("modal store", () => {
  it("As a dotli integrator, an opened modal is queued in order and resolves with the chosen result", async () => {
    // Given
    const first = openModal(view("First"));
    const second = openModal(view("Second"));
    const entries = modalsStore.get();
    const a = nth(entries, 0);
    const b = nth(entries, 1);

    // Then
    expect(modalsStore.get().map((e) => e.view.title)).toEqual([
      "First",
      "Second",
    ]);

    // When
    settleModal(a.id, "yes");

    // Then
    await expect(first).resolves.toEqual({ result: "yes" });
    expect(modalsStore.get().map((e) => e.id)).toEqual([b.id]);

    // When
    settleModal(b.id, "no", "typed");

    // Then
    await expect(second).resolves.toEqual({ result: "no", value: "typed" });
    expect(modalsStore.get()).toEqual([]);
  });

  it("As a dotli integrator, a modal settles only once", async () => {
    // Given
    const outcome = openModal(view("Once"));
    const entry = nth(modalsStore.get(), 0);

    // When
    settleModal(entry.id, "yes");
    settleModal(entry.id, "no");
    failAllModals();

    // Then
    await expect(outcome).resolves.toEqual({ result: "yes" });
  });

  it("As a dotli integrator, an already aborted signal rejects without queueing anything", async () => {
    // Given
    const controller = new AbortController();
    controller.abort("gone");

    // When
    const outcome = openModal(view("Aborted"), controller.signal);

    // Then
    await expect(outcome).rejects.toMatchObject({ name: "AbortError" });
    expect(modalsStore.get()).toEqual([]);
  });

  it("As a dotli integrator, aborting an open modal removes it and rejects with AbortError", async () => {
    // Given
    const controller = new AbortController();
    const outcome = openModal(view("Open"), controller.signal);

    // When
    controller.abort();

    // Then
    await expect(outcome).rejects.toMatchObject({ name: "AbortError" });
    expect(modalsStore.get()).toEqual([]);
  });

  it("As a dotli user, when the overlays cannot render every open modal settles with its fallback result", async () => {
    // Given
    const first = openModal(view("First"));
    const second = openModal({ ...view("Second"), fallbackResult: "no" });

    // When
    failAllModals();

    // Then
    await expect(first).resolves.toEqual({ result: "dismissed" });
    await expect(second).resolves.toEqual({ result: "no" });
    expect(modalsStore.get()).toEqual([]);
  });
});
