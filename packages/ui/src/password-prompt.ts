// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Password prompt modal for encrypted SPAs
//
// Shows a modal asking the user for a decryption password.
// Follows the same DOM pattern as permission-modal.ts and signing.css.

/**
 * Show a password prompt modal. Resolves with the entered password,
 * or rejects if the user cancels.
 */
export function showPasswordPrompt(opts?: { error?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const backdrop = document.createElement("div");
    backdrop.className = "signing-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "signing-modal";

    // Icon
    const iconWrap = document.createElement("div");
    iconWrap.className = "permission-modal-icon";
    iconWrap.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>' +
      '<path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
    modal.appendChild(iconWrap);

    // Heading
    const heading = document.createElement("h2");
    heading.textContent = "Encrypted Content";
    modal.appendChild(heading);

    // Description
    const desc = document.createElement("div");
    desc.className = "signing-fields";

    const hint = document.createElement("div");
    hint.className = "signing-field-value";
    hint.textContent =
      "This content is password-protected. Enter the password to decrypt.";
    desc.appendChild(hint);

    // Error message (wrong password retry)
    if (opts?.error !== undefined && opts.error !== "") {
      const errEl = document.createElement("div");
      errEl.className = "password-prompt-error";
      errEl.textContent = opts.error;
      desc.appendChild(errEl);
    }

    // Password input
    const input = document.createElement("input");
    input.type = "password";
    input.className = "password-prompt-input";
    input.placeholder = "Password";
    input.autocomplete = "off";
    input.spellcheck = false;
    desc.appendChild(input);

    modal.appendChild(desc);

    // Footer
    const footer = document.createElement("div");
    footer.className = "signing-modal-footer";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "signing-btn-cancel";
    cancelBtn.textContent = "Cancel";
    footer.appendChild(cancelBtn);

    const unlockBtn = document.createElement("button");
    unlockBtn.className = "signing-btn-sign";
    unlockBtn.textContent = "Unlock";
    unlockBtn.disabled = true;
    footer.appendChild(unlockBtn);

    modal.appendChild(footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // Enable button when input is non-empty
    input.addEventListener("input", () => {
      unlockBtn.disabled = input.value === "";
    });

    function cleanup(): void {
      backdrop.remove();
    }

    function submit(): void {
      const password = input.value;
      if (password === "") {
        return;
      }
      cleanup();
      resolve(password);
    }

    unlockBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        submit();
      }
    });

    cancelBtn.addEventListener("click", () => {
      cleanup();
      reject(new Error("User cancelled decryption"));
    });

    // Clicking the backdrop should not dismiss. The user must explicitly
    // cancel or submit. Encrypted content has no fallback to show.

    // Focus the input after appending to DOM
    requestAnimationFrame(() => {
      input.focus();
    });
  });
}
