// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import {
  isDevicePermission,
  type EnforceablePermissionName,
} from "./permissions";

// dot.li Permission request modal (vanilla DOM)
//
// Shows a confirmation dialog when a product requests a permission the
// host can actually gate: the Permissions-Policy-backed device
// variants (Camera, Microphone, Location, Bluetooth, NFC, Clipboard,
// Biometrics, Notifications) and the internal submitted gates (ChainSubmit,
// PreimageSubmit, StatementSubmit). `OpenUrl` is auto-granted at the
// container level and never reaches this modal.
// Returns a Promise that resolves on "Allow" and rejects on "Deny".
//
// DOM structure follows the signing modal pattern (signing.css).

export const PERMISSION_DESCRIPTIONS: Record<
  EnforceablePermissionName,
  string
> = {
  Notifications: "Show in-app and system notifications",
  Camera: "Access your camera for photo and video capture",
  Microphone: "Access your microphone for audio input",
  Location: "Access your location for geolocation services",
  Bluetooth: "Connect to nearby Bluetooth devices",
  NFC: "Read and write nearby NFC tags",
  Clipboard: "Read text and data from your clipboard",
  Biometrics: "Authenticate with a platform passkey or biometric prompt",
  ChainSubmit: "Sign and submit on-chain transactions on your behalf",
  PreimageSubmit: "Store preimage data on-chain via the Bulletin network",
  StatementSubmit: "Submit signed statements to the statement store",
  GetUserId: "Reveal your dotNS username to this app",
};

const PERMISSION_ICONS: Record<EnforceablePermissionName, string> = {
  Notifications:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>' +
    '<path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  Camera:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>' +
    '<circle cx="12" cy="13" r="4"/></svg>',
  Microphone:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>' +
    '<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>' +
    '<line x1="12" y1="19" x2="12" y2="23"/>' +
    '<line x1="8" y1="23" x2="16" y2="23"/></svg>',
  Location:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>' +
    '<circle cx="12" cy="10" r="3"/></svg>',
  Bluetooth:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/></svg>',
  NFC:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M17 7a7 7 0 0 1 0 10"/>' +
    '<path d="M13 9a4 4 0 0 1 0 6"/>' +
    '<circle cx="9" cy="12" r="1" fill="currentColor" stroke="none"/></svg>',
  Clipboard:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>' +
    '<rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
  Biometrics:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 11a4 4 0 0 0-4 4v2a4 4 0 0 0 8 0v-2a4 4 0 0 0-4-4z"/>' +
    '<path d="M6 11a6 6 0 0 1 12 0"/>' +
    '<path d="M4 11a8 8 0 0 1 16 0"/></svg>',
  ChainSubmit:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>' +
    '<polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  PreimageSubmit:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
    '<polyline points="17 8 12 3 7 8"/>' +
    '<line x1="12" y1="3" x2="12" y2="15"/></svg>',
  StatementSubmit:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
    '<polyline points="14 2 14 8 20 8"/>' +
    '<line x1="8" y1="13" x2="16" y2="13"/>' +
    '<line x1="8" y1="17" x2="14" y2="17"/></svg>',
  GetUserId:
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>' +
    '<circle cx="12" cy="7" r="4"/></svg>',
};

/**
 * Show a permission request modal. Resolves when the user clicks "Allow",
 * rejects when the user clicks "Deny".
 */
export function showPermissionRequestModal(
  label: string,
  permission: EnforceablePermissionName,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const backdrop = document.createElement("div");
    backdrop.className = "signing-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "signing-modal";

    // Icon
    const iconWrap = document.createElement("div");
    iconWrap.className = "permission-modal-icon";
    iconWrap.innerHTML = PERMISSION_ICONS[permission];
    modal.appendChild(iconWrap);

    // Heading
    const heading = document.createElement("h2");
    heading.textContent = "Permission Request";
    modal.appendChild(heading);

    // Description
    const desc = document.createElement("div");
    desc.className = "signing-fields";

    const productField = document.createElement("div");
    productField.className = "signing-field";

    const productLabel = document.createElement("div");
    productLabel.className = "signing-field-label";
    productLabel.textContent = "Application";
    productField.appendChild(productLabel);

    const productValue = document.createElement("div");
    productValue.className = "signing-field-value";
    productValue.textContent = `${label}.dot`;
    productField.appendChild(productValue);

    desc.appendChild(productField);

    const permField = document.createElement("div");
    permField.className = "signing-field";

    const permLabel = document.createElement("div");
    permLabel.className = "signing-field-label";
    permLabel.textContent = "Permission";
    permField.appendChild(permLabel);

    const permValue = document.createElement("div");
    permValue.className = "signing-field-value";
    permValue.textContent = PERMISSION_DESCRIPTIONS[permission];
    permField.appendChild(permValue);

    desc.appendChild(permField);

    if (isDevicePermission(permission)) {
      const notice = document.createElement("div");
      notice.className = "permission-modal-notice";
      notice.textContent =
        "Granting this permission will reload the application.";
      desc.appendChild(notice);
    }

    modal.appendChild(desc);

    // Footer
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
      reject(new Error("User denied permission"));
    });

    allowBtn.addEventListener("click", () => {
      cleanup();
      resolve();
    });

    // Close on backdrop click (outside modal)
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        cleanup();
        reject(new Error("User dismissed permission dialog"));
      }
    });
  });
}
