// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Preimage submit confirmation modal (vanilla DOM)
//
// Shows a confirmation dialog when a product requests to store
// preimage data on the Bulletin chain. Returns a Promise that
// resolves on "Allow" and rejects on "Cancel".
//
// DOM structure follows the signing modal pattern (signing.ts).

function formatSize(bytes: number): string {
  return bytes >= 1024
    ? `${String(Math.round(bytes / 1024))} KB`
    : `${String(bytes)} B`;
}

export function showPreimageSubmitModal(dataSize: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const backdrop = document.createElement("div");
    backdrop.className = "signing-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "signing-modal";

    const heading = document.createElement("h2");
    heading.textContent = "Submit Preimage";
    modal.appendChild(heading);

    const fieldsContainer = document.createElement("div");
    fieldsContainer.className = "signing-fields";

    const group = document.createElement("div");
    group.className = "signing-field";

    const label = document.createElement("div");
    label.className = "signing-field-label";
    label.textContent = "Data size";
    group.appendChild(label);

    const value = document.createElement("div");
    value.className = "signing-field-value";
    value.textContent = formatSize(dataSize);
    group.appendChild(value);

    fieldsContainer.appendChild(group);
    modal.appendChild(fieldsContainer);

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

    cancelBtn.addEventListener("click", () => {
      cleanup();
      reject(new Error("User denied preimage submit"));
    });

    allowBtn.addEventListener("click", () => {
      cleanup();
      resolve();
    });
  });
}
