// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from "vitest";
import {
  showAllocationRequestModal,
  type AllocatableResourceValue,
  type AllocationOutcomeValue,
} from "@dotli/ui/allocation-modal";

afterEach(() => {
  document.body.innerHTML = "";
});

function findModal(): HTMLElement {
  const modal = document.querySelector(".signing-modal");
  if (!(modal instanceof HTMLElement)) {
    throw new Error("modal not mounted");
  }
  return modal;
}

function clickButton(text: string): void {
  const buttons = Array.from(document.querySelectorAll("button"));
  const button = buttons.find((b) => b.textContent === text);
  if (!button) throw new Error(`button "${text}" not found`);
  button.click();
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("showAllocationRequestModal", () => {
  const allowed: AllocationOutcomeValue[] = [
    { tag: "Allocated", value: undefined },
  ];

  it("renders one item per resource with the expected label", () => {
    const resources: AllocatableResourceValue[] = [
      { tag: "StatementStoreAllowance", value: undefined },
      { tag: "BulletinAllowance", value: undefined },
      { tag: "SmartContractAllowance", value: 5 },
      { tag: "AutoSigning", value: undefined },
    ];

    void showAllocationRequestModal("myapp", resources, async () => allowed);

    const items = Array.from(
      findModal().querySelectorAll(".allocation-modal-list li"),
    ).map((li) => li.textContent);

    expect(items).toEqual([
      "Post statements on your behalf",
      "Publish bulletin posts on your behalf",
      "Sign up to 5 smart-contract calls automatically",
      "Sign transactions automatically",
    ]);
  });

  it("resolves with the wallet outcomes on Allow", async () => {
    const resources: AllocatableResourceValue[] = [
      { tag: "StatementStoreAllowance", value: undefined },
    ];
    const promise = showAllocationRequestModal(
      "myapp",
      resources,
      async () => allowed,
    );

    clickButton("Allow");
    await expect(promise).resolves.toEqual(allowed);
    expect(document.querySelector(".signing-modal")).toBeNull();
  });

  it("rejects on Cancel and removes the modal", async () => {
    const resources: AllocatableResourceValue[] = [
      { tag: "BulletinAllowance", value: undefined },
    ];
    const promise = showAllocationRequestModal(
      "myapp",
      resources,
      async () => allowed,
    );

    clickButton("Cancel");
    await expect(promise).rejects.toThrow();
    expect(document.querySelector(".signing-modal")).toBeNull();
  });

  it("rejects on backdrop click while not pending", async () => {
    const resources: AllocatableResourceValue[] = [
      { tag: "AutoSigning", value: undefined },
    ];
    const promise = showAllocationRequestModal(
      "myapp",
      resources,
      async () => allowed,
    );

    const backdrop = document.querySelector(".signing-modal-backdrop");
    if (!(backdrop instanceof HTMLElement)) {
      throw new Error("backdrop not mounted");
    }
    backdrop.click();
    await expect(promise).rejects.toThrow();
    expect(document.querySelector(".signing-modal")).toBeNull();
  });

  it("keeps the modal open and shows the error when performAllocation rejects", async () => {
    const resources: AllocatableResourceValue[] = [
      { tag: "StatementStoreAllowance", value: undefined },
    ];
    let attempts = 0;
    const performAllocation = async (): Promise<AllocationOutcomeValue[]> => {
      attempts += 1;
      if (attempts === 1) throw new Error("phone unreachable");
      return allowed;
    };

    const promise = showAllocationRequestModal(
      "myapp",
      resources,
      performAllocation,
    );

    clickButton("Allow");
    await flush();
    await flush();

    const errorBox = document.querySelector(".allocation-modal-error");
    expect(errorBox?.textContent).toBe("phone unreachable");
    expect(document.querySelector(".signing-modal")).not.toBeNull();

    const allow = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Allow",
    );
    expect(allow?.disabled).toBe(false);

    // Retry path settles the original promise.
    clickButton("Allow");
    await expect(promise).resolves.toEqual(allowed);
    expect(attempts).toBe(2);
  });
});
