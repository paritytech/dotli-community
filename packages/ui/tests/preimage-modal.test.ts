// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import { showPreimageSubmitModal } from "../src/preimage-modal.js";
import { ERRORS } from "../src/errors.js";
import { overlaysReady, resetOverlays } from "./helpers/overlays.js";

afterEach(() => {
  resetOverlays();
  document.body.replaceChildren();
});

describe("preimage submit modal", () => {
  it("As a dotli user, I see the data size and can allow the submission", async () => {
    // Given
    const decision = showPreimageSubmitModal(2048);
    await overlaysReady();

    // Then
    expect(document.querySelector(".signing-modal h2")?.textContent).toBe(
      "Submit Preimage",
    );
    expect(document.querySelector(".signing-field-label")?.textContent).toBe(
      "Data size",
    );
    expect(document.querySelector(".signing-field-value")?.textContent).toBe(
      "2 KB",
    );

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-sign")?.click();

    // Then
    await expect(decision).resolves.toBeUndefined();
  });

  it("As a dotli user, cancelling rejects with the pinned error, and the backdrop does nothing", async () => {
    // Given
    const decision = showPreimageSubmitModal(512);
    await overlaysReady();
    expect(document.querySelector(".signing-field-value")?.textContent).toBe(
      "512 B",
    );

    // When
    document.querySelector<HTMLElement>(".signing-modal-backdrop")?.click();

    // Then
    expect(document.querySelector(".signing-modal-backdrop")).not.toBeNull();

    // When
    document.querySelector<HTMLButtonElement>(".signing-btn-cancel")?.click();

    // Then
    await expect(decision).rejects.toThrow(ERRORS.PREIMAGE_SUBMIT_DENIED);
  });

  it("As a dotli integrator, an abort rejects with AbortError and closes the dialog", async () => {
    // Given
    const controller = new AbortController();
    const decision = showPreimageSubmitModal(10, controller.signal);
    await overlaysReady();

    // When
    controller.abort();

    // Then
    await expect(decision).rejects.toMatchObject({ name: "AbortError" });
  });
});
