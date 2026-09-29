// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The markup the imperative topbar.ts produced for the auth button, the user
// popover and the pairing modal before they became islands (commit 650a9df9):
// Shell.tsx's static markup, changed by the same writes topbar.ts made. The
// island tests compare against it node for node.

import { escapeHtml } from "@dotli/shared";
import { query } from "../../support.js";

const USER_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

const STATIC_AUTH_BUTTON = `<button id="auth-button" class="topbar-btn" title="Connecting..." aria-label="Connecting..." aria-busy="true" disabled>${USER_SVG}</button>`;

const STATIC_MODAL = `<div class="auth-modal-backdrop" id="auth-modal-backdrop"><div class="auth-modal"><h2 id="auth-modal-title">Login with Polkadot Mobile</h2><p class="auth-modal-reason" id="auth-modal-reason" hidden></p><p id="auth-modal-hint">Scan with Polkadot Mobile to connect</p><div class="auth-modal-qr" id="auth-modal-qr"><div class="spinner"></div></div><a class="auth-modal-get-app" id="auth-modal-get-app" target="_blank" rel="noopener noreferrer" hidden>Don't have the app? Get Polkadot Mobile</a><button class="auth-modal-close" id="auth-modal-close">Cancel</button></div></div>`;

const STATIC_USER_POPOVER = `<div class="user-popover" id="user-popover"><div class="user-popover-name"><div class="label">Welcome back</div><div class="name" id="user-popover-username"></div></div><div class="user-popover-divider"></div><button class="user-popover-disconnect" id="user-popover-disconnect"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>Log out</button></div>`;

const PENDING_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

function fromHtml(html: string): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.firstElementChild as HTMLElement;
}

/**
 * A copy of `el` that compares by content: adjacent text merged, and the
 * whitespace-only text, empty text and comments that differ between an
 * `innerHTML` template string and a JSX template removed.
 */
export function normalized(el: Element): Element {
  const copy = el.cloneNode(true) as Element;
  copy.normalize();
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_ALL);
  const drop: Node[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (
      node.nodeType === Node.COMMENT_NODE ||
      (node.nodeType === Node.TEXT_NODE &&
        (node.textContent ?? "").trim() === "")
    ) {
      drop.push(node);
    }
  }
  for (const node of drop) {
    node.parentNode?.removeChild(node);
  }
  return copy;
}

// --- auth button (initTopBar, renderLoggedOut, renderTruapiLoggedIn) ---

export function oldAuthButton(
  state: { initials: string | undefined } | "logged-out",
): HTMLElement {
  const button = fromHtml(STATIC_AUTH_BUTTON);
  button.removeAttribute("disabled");
  button.removeAttribute("aria-busy");
  if (state === "logged-out") {
    button.innerHTML = USER_SVG;
    button.title = "Login with Polkadot Mobile";
    button.setAttribute("aria-label", "Login with Polkadot Mobile");
  } else {
    button.innerHTML =
      state.initials !== undefined
        ? `<div class="user-badge">${escapeHtml(state.initials)}</div>`
        : `<div class="user-badge user-badge-anon">${USER_SVG}</div>`;
    button.title = "Account";
    button.setAttribute("aria-label", "Account");
  }
  return button;
}

// --- user popover (renderTruapiLoggedIn, setUserPopoverNoUsernameHint) ---

export function oldUserPopover(opts: {
  username: string;
  hint: boolean;
  open: boolean;
}): HTMLElement {
  const popover = fromHtml(STATIC_USER_POPOVER);
  const name = query(popover, "#user-popover-username");
  name.textContent = opts.username;
  if (opts.hint) {
    const hint = document.createElement("div");
    hint.id = "user-popover-hint";
    hint.className = "user-popover-hint";
    hint.textContent = "No username found for this account on this network.";
    name.insertAdjacentElement("afterend", hint);
  }
  if (opts.open) {
    popover.classList.add("open");
  }
  return popover;
}

// --- pairing modal (initTopBar, openModal, render*, closeModal) ---

export type OldModalBody =
  | { kind: "empty" }
  | { kind: "spinner" }
  | { kind: "canvas"; payload: string }
  | { kind: "mobile-qr"; payload: string; qrShown: boolean }
  | { kind: "authenticating" }
  | {
      kind: "error";
      title: string;
      subtitle: string;
      detail?: string;
      retry: boolean;
    };

export function oldModal(opts: {
  open: boolean;
  productLabel?: string;
  reason?: string;
  hint: string;
  getAppHidden: boolean;
  body: OldModalBody;
  mobileClass?: boolean;
}): HTMLElement {
  const backdrop = fromHtml(STATIC_MODAL);
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-labelledby", "auth-modal-title");
  backdrop.tabIndex = -1;
  const find = (id: string): HTMLElement => query(backdrop, `#${id}`);
  const title = find("auth-modal-title");
  const reason = find("auth-modal-reason");
  const hint = find("auth-modal-hint");
  const qr = find("auth-modal-qr");
  const getApp = find("auth-modal-get-app") as HTMLAnchorElement;
  getApp.href = "https://docs.polkadot.com/apps/";

  title.innerHTML =
    opts.productLabel !== undefined
      ? `${escapeHtml(opts.productLabel)} is asking you <span class="auth-modal-title-nowrap">to sign in</span>`
      : "Login with Polkadot Mobile";
  if (opts.reason !== undefined) {
    reason.textContent = opts.reason;
    reason.hidden = false;
  } else {
    reason.textContent = "";
    reason.hidden = true;
  }
  hint.textContent = opts.hint;
  getApp.hidden = opts.getAppHidden;
  if (opts.open) {
    backdrop.classList.add("open");
  }
  if (opts.mobileClass === true) {
    qr.classList.add("auth-modal-qr-mobile");
  }

  const body = opts.body;
  switch (body.kind) {
    case "empty":
      qr.innerHTML = "";
      break;
    case "spinner":
      qr.innerHTML = `<div class="spinner"></div>`;
      break;
    case "canvas": {
      const canvas = document.createElement("canvas");
      canvas.dataset["qrPayload"] = body.payload;
      qr.innerHTML = "";
      qr.appendChild(canvas);
      break;
    }
    case "mobile-qr": {
      const canvas = document.createElement("canvas");
      canvas.dataset["qrPayload"] = body.payload;
      qr.innerHTML = "";
      const qrLink = document.createElement("a");
      qrLink.href = body.payload;
      qrLink.className = "auth-modal-qr-link";
      qrLink.appendChild(canvas);
      qrLink.hidden = true;
      const openApp = document.createElement("a");
      openApp.href = body.payload;
      openApp.className = "auth-modal-open-app";
      openApp.textContent = "Login With Polkadot App";
      const showQr = document.createElement("button");
      showQr.type = "button";
      showQr.className = "auth-modal-qr-toggle";
      showQr.textContent = "Show QR instead";
      qr.append(openApp, showQr, qrLink);
      if (body.qrShown) {
        qrLink.hidden = false;
        openApp.classList.add("auth-modal-open-app-link");
        showQr.hidden = true;
        qr.append(qrLink, openApp);
      }
      break;
    }
    case "authenticating":
      qr.innerHTML = `
    <div class="attesting">
      <div class="spinner"></div>
      <p>Logging in...</p>
    </div>
  `;
      break;
    case "error": {
      const container = document.createElement("div");
      container.className = "auth-modal-error-view";
      const icon = document.createElement("div");
      icon.className = "auth-modal-pending-icon";
      icon.innerHTML = PENDING_ICON_SVG;
      container.appendChild(icon);
      const heading = document.createElement("div");
      heading.className = "auth-modal-pending-title";
      heading.textContent = body.title;
      container.appendChild(heading);
      const subtitle = document.createElement("div");
      subtitle.className = "auth-modal-pending-subtitle";
      subtitle.textContent = body.subtitle;
      container.appendChild(subtitle);
      if (body.detail !== undefined && body.detail.length > 0) {
        const detail = document.createElement("p");
        detail.className = "auth-modal-error";
        detail.textContent = body.detail;
        container.appendChild(detail);
      }
      if (body.retry) {
        const retry = document.createElement("button");
        retry.className = "auth-modal-retry";
        retry.textContent = "Retry";
        container.appendChild(retry);
      }
      qr.innerHTML = "";
      qr.appendChild(container);
      break;
    }
  }
  return backdrop;
}
