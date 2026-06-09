// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Allowance request modal.
 *
 * Lists the resources a product wants pre-allocated and runs the wallet
 * round-trip on Allow. On error the modal stays open so the user can retry.
 */

import type { AllocatableResource, AllocationOutcome } from "@parity/truapi";

export type AllocatableResourceValue = AllocatableResource;
export type AllocationOutcomeValue = AllocationOutcome;

function describeResource(resource: AllocatableResourceValue): string {
  switch (resource.tag) {
    case "StatementStoreAllowance":
      return "Post statements on your behalf";
    case "BulletinAllowance":
      return "Publish bulletin posts on your behalf";
    case "SmartContractAllowance":
      return `Sign up to ${String(resource.value)} smart-contract calls automatically`;
    case "AutoSigning":
      return "Sign transactions automatically";
    default: {
      const exhaustive: never = resource;
      return exhaustive;
    }
  }
}

/** Show an allowance request modal and run `performAllocation` on confirm. */
export function showAllocationRequestModal(
  productLabel: string,
  resources: AllocatableResourceValue[],
  performAllocation: () => Promise<AllocationOutcomeValue[]>,
): Promise<AllocationOutcomeValue[]> {
  return new Promise((resolve, reject) => {
    const backdrop = document.createElement("div");
    backdrop.className = "signing-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "signing-modal";

    const heading = document.createElement("h2");
    heading.textContent = "Allowance request";
    modal.appendChild(heading);

    const description = document.createElement("div");
    description.className = "signing-fields";

    const productField = document.createElement("div");
    productField.className = "signing-field";

    const productFieldLabel = document.createElement("div");
    productFieldLabel.className = "signing-field-label";
    productFieldLabel.textContent = "Application";
    productField.appendChild(productFieldLabel);

    const productFieldValue = document.createElement("div");
    productFieldValue.className = "signing-field-value";
    productFieldValue.textContent = productLabel;
    productField.appendChild(productFieldValue);

    description.appendChild(productField);

    const resourcesField = document.createElement("div");
    resourcesField.className = "signing-field";

    const resourcesLabel = document.createElement("div");
    resourcesLabel.className = "signing-field-label";
    resourcesLabel.textContent = "Requested allowances";
    resourcesField.appendChild(resourcesLabel);

    const list = document.createElement("ul");
    list.className = "allocation-modal-list";
    for (const resource of resources) {
      const item = document.createElement("li");
      item.textContent = describeResource(resource);
      list.appendChild(item);
    }
    resourcesField.appendChild(list);

    description.appendChild(resourcesField);

    const errorBox = document.createElement("div");
    errorBox.className = "allocation-modal-error";
    errorBox.style.display = "none";
    description.appendChild(errorBox);

    modal.appendChild(description);

    const footer = document.createElement("div");
    footer.className = "signing-modal-footer";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "signing-btn-cancel";
    cancelBtn.textContent = "Cancel";
    footer.appendChild(cancelBtn);

    const allowBtn = document.createElement("button");
    allowBtn.className = "signing-btn-sign";
    allowBtn.textContent = "Allow";
    footer.appendChild(allowBtn);

    modal.appendChild(footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    function cleanup(): void {
      backdrop.remove();
    }

    function setPending(pending: boolean): void {
      cancelBtn.disabled = pending;
      allowBtn.disabled = pending;
      allowBtn.textContent = pending ? "Allocating..." : "Allow";
    }

    function showError(message: string): void {
      errorBox.textContent = message;
      errorBox.style.display = "";
    }

    cancelBtn.addEventListener("click", () => {
      cleanup();
      reject(new Error("User cancelled allowance request"));
    });

    allowBtn.addEventListener("click", () => {
      errorBox.style.display = "none";
      setPending(true);
      performAllocation().then(
        (outcomes) => {
          cleanup();
          resolve(outcomes);
        },
        (error: unknown) => {
          setPending(false);
          showError(error instanceof Error ? error.message : String(error));
        },
      );
    });

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop && !allowBtn.disabled) {
        cleanup();
        reject(new Error("User dismissed allowance request"));
      }
    });
  });
}
