// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Alias permission modal (vanilla DOM)
//
// Shows a confirmation dialog when a product requests an alias
// in the context of a different domain. Returns a Promise that
// resolves on "Allow" and rejects on "Deny".
//
// DOM structure follows the signing modal pattern (signing.css).

export function showAliasPermissionModal(
  requestingIdentifier: string,
  requestedIdentifier: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const backdrop = document.createElement("div");
    backdrop.className = "signing-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "signing-modal";

    const heading = document.createElement("h2");
    heading.textContent = "Alias Permission";
    modal.appendChild(heading);

    const fieldsContainer = document.createElement("div");
    fieldsContainer.className = "signing-fields";

    const requestingField = document.createElement("div");
    requestingField.className = "signing-field";

    const requestingLabel = document.createElement("div");
    requestingLabel.className = "signing-field-label";
    requestingLabel.textContent = "Requesting product";
    requestingField.appendChild(requestingLabel);

    const requestingValue = document.createElement("div");
    requestingValue.className = "signing-field-value";
    requestingValue.textContent = requestingIdentifier;
    requestingField.appendChild(requestingValue);

    fieldsContainer.appendChild(requestingField);

    const requestedField = document.createElement("div");
    requestedField.className = "signing-field";

    const requestedLabel = document.createElement("div");
    requestedLabel.className = "signing-field-label";
    requestedLabel.textContent = "Requested context";
    requestedField.appendChild(requestedLabel);

    const requestedValue = document.createElement("div");
    requestedValue.className = "signing-field-value";
    requestedValue.textContent = requestedIdentifier;
    requestedField.appendChild(requestedValue);

    fieldsContainer.appendChild(requestedField);
    modal.appendChild(fieldsContainer);

    const footer = document.createElement("div");
    footer.className = "signing-modal-footer";

    const denyBtn = document.createElement("button");
    denyBtn.className = "signing-btn-cancel";
    denyBtn.textContent = "Deny";
    footer.appendChild(denyBtn);

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

    denyBtn.addEventListener("click", () => {
      cleanup();
      reject(new Error("User denied alias permission"));
    });

    allowBtn.addEventListener("click", () => {
      cleanup();
      resolve();
    });

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        cleanup();
        reject(new Error("User dismissed alias permission dialog"));
      }
    });
  });
}
