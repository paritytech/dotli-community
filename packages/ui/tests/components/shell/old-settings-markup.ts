// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The markup the imperative topbar.ts produced for the settings ("mode")
// button, backdrop and popover before they became an island (commit
// 07463e3d): Shell.tsx's static markup, changed by the writes
// initModeToggle and setModePopoverOpen made, and filled by
// renderModePopover's and renderDiagnostics' render on open. The builders
// below are that code, copied as it was, with what it read from
// @dotli/config/* passed in instead and its listeners left out. The
// diagnostics rows' data comes from settings-actions.ts, where those
// functions moved unchanged. The island tests compare against it node for
// node.

import {
  BACKEND_LABELS,
  type Backend,
  type CacheSettings,
  NETWORK_NAME_TO_SERVICES_CONFIG,
  type Network,
} from "@dotli/config";

import {
  buildBaseDiagnosticsRows,
  buildLightClientVersionLabel,
  packageVersions,
} from "../../../src/settings-actions.js";

const SETTINGS_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

const STATIC_BUTTON = `<button id="mode-button" class="topbar-btn" title="Settings" aria-label="Settings">${SETTINGS_SVG}</button>`;

const STATIC_BACKDROP = `<div class="mode-popover-backdrop" id="mode-popover-backdrop"></div>`;

const STATIC_POPOVER = `<div class="mode-popover" id="mode-popover"><div class="mode-popover-content" id="mode-popover-content"></div></div>`;

function fromHtml(html: string): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.firstElementChild as HTMLElement;
}

/** The button after initModeToggle (and setModePopoverOpen). */
export function oldModeButton(opts: {
  open: boolean;
  verified: boolean;
}): HTMLElement {
  const button = fromHtml(STATIC_BUTTON);
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "mode-popover");
  button.classList.toggle("gateway-mode", !opts.verified);
  button.setAttribute("aria-expanded", String(opts.open));
  return button;
}

/** The backdrop after setModePopoverOpen. */
export function oldModeBackdrop(opts: { open: boolean }): HTMLElement {
  const backdrop = fromHtml(STATIC_BACKDROP);
  backdrop.classList.toggle("open", opts.open);
  return backdrop;
}

/** What renderModePopover read from @dotli/config/* when it opened. */
export interface OldSettings {
  chain: Backend;
  network: Network;
  cache: CacheSettings;
  enabledNetworks: Network[];
  sharedWorkerSupported: boolean;
  debugOn: boolean;
}

/**
 * The popover after initModeToggle and, when open, renderModePopover's first
 * render (nothing changed yet, so Save & Apply is disabled).
 */
export function oldModePopover(
  opts: { open: false } | ({ open: true } & OldSettings),
): HTMLElement {
  const modePopover = fromHtml(STATIC_POPOVER);
  modePopover.setAttribute("role", "dialog");
  modePopover.setAttribute("aria-label", "Settings");
  modePopover.tabIndex = -1;
  if (!opts.open) {
    return modePopover;
  }
  modePopover.classList.toggle("open", true);
  const parent = modePopover.firstElementChild as HTMLElement;

  const sheetHeader = document.createElement("div");
  sheetHeader.className = "mode-popover-sheet-header";
  const sheetTitle = document.createElement("span");
  sheetTitle.className = "mode-popover-sheet-title";
  sheetTitle.textContent = "Settings";
  const sheetClose = document.createElement("button");
  sheetClose.className = "mode-popover-sheet-close";
  sheetClose.setAttribute("aria-label", "Close settings");
  sheetClose.textContent = "✕";
  sheetHeader.append(sheetTitle, sheetClose);
  parent.appendChild(sheetHeader);

  const draft = { chain: opts.chain, network: opts.network, cache: opts.cache };

  const columns = document.createElement("div");
  columns.className = "mode-popover-columns";
  parent.appendChild(columns);

  const leftCol = document.createElement("div");
  leftCol.className = "mode-popover-col";
  columns.appendChild(leftCol);

  const rightCol = document.createElement("div");
  rightCol.className = "mode-popover-col";
  columns.appendChild(rightCol);

  const enabledNetworks = opts.enabledNetworks;
  if (enabledNetworks.length > 1) {
    appendSectionHeader(leftCol, "Network");
    const networkGroup = document.createElement("div");
    networkGroup.setAttribute("role", "radiogroup");
    networkGroup.setAttribute("aria-label", "Network");
    leftCol.appendChild(networkGroup);
    for (const n of enabledNetworks) {
      const cfg = NETWORK_NAME_TO_SERVICES_CONFIG[n];
      networkGroup.appendChild(
        buildRadioRow("dotli-network", {
          value: n,
          label: cfg.label,
          description: cfg.description,
          selected: n === draft.network,
        }),
      );
    }
  }

  appendSectionHeader(
    leftCol,
    "Network Transport",
    enabledNetworks.length > 1 ? "mode-popover-section--spaced" : undefined,
  );
  const chainChoices: [Backend, string, string][] = [
    [
      "smoldot-direct",
      BACKEND_LABELS["smoldot-direct"],
      "Verified in your browser, separate per tab (recommended)",
    ],
    [
      "smoldot-shared-worker",
      BACKEND_LABELS["smoldot-shared-worker"],
      "Verified in your browser, shared across tabs",
    ],
    [
      "rpc-gateway",
      BACKEND_LABELS["rpc-gateway"],
      "Fetched from trusted servers, fastest but less private",
    ],
  ];
  const chainGroup = document.createElement("div");
  chainGroup.setAttribute("role", "radiogroup");
  chainGroup.setAttribute("aria-label", "Network Transport");
  leftCol.appendChild(chainGroup);
  for (const [value, label, desc] of chainChoices) {
    const disabled =
      value === "smoldot-shared-worker" && !opts.sharedWorkerSupported;
    chainGroup.appendChild(
      buildRadioRow("dotli-backend", {
        value,
        label,
        description: disabled
          ? "Unavailable in this browser or private window"
          : desc,
        selected: value === draft.chain,
        disabled,
      }),
    );
  }

  appendSectionHeader(leftCol, "Cache", "mode-popover-section--bottom");
  renderCacheToggle(leftCol, "dotNS cache", !draft.cache.skipCidCache);
  renderCacheToggle(leftCol, "Archive cache", !draft.cache.skipArchiveCache);
  renderCacheToggle(leftCol, "Worker cache", !draft.cache.skipWorkerCache);

  const clearRow = document.createElement("div");
  clearRow.className = "mode-cache-row mode-clear-all-row";
  const clearBtn = document.createElement("button");
  clearBtn.className = "mode-clear-btn";
  clearBtn.textContent = "Clear all caches";
  clearBtn.title =
    "Wipe every cache, database, and worker across all origins. The app will reload from a clean baseline.";
  clearRow.appendChild(clearBtn);
  leftCol.appendChild(clearRow);

  appendSectionHeader(rightCol, "Diagnostics");
  renderDiagnostics(rightCol, opts.debugOn);

  const footer = document.createElement("div");
  footer.className = "mode-apply-footer";
  parent.appendChild(footer);

  const divider = document.createElement("div");
  divider.className = "mode-popover-divider";
  footer.appendChild(divider);
  const applyRow = document.createElement("div");
  applyRow.className = "mode-cache-row mode-apply-row";
  const applyBtn = document.createElement("button");
  applyBtn.className = "mode-clear-btn";
  applyRow.appendChild(applyBtn);
  footer.appendChild(applyRow);

  const resetWarning = document.createElement("p");
  resetWarning.className = "mode-apply-warning";
  resetWarning.textContent =
    "Applying reloads the app. Caches you turn off are cleared.";
  footer.appendChild(resetWarning);

  // syncApply, on the untouched draft.
  applyBtn.disabled = true;
  applyBtn.textContent = "Save & Apply";
  applyBtn.classList.toggle("mode-apply-dirty", false);
  resetWarning.classList.toggle("visible", false);

  return modePopover;
}

function renderDiagnostics(parent: HTMLElement, debugOn: boolean): void {
  const base = buildBaseDiagnosticsRows();
  const COPYABLE_ROWS = new Set([
    "Site",
    "Relay node",
    "AssetHub node",
    "Bulletin Node",
  ]);
  for (const entry of base) {
    renderInfoRow(parent, entry[0], entry[1], {
      copyable: COPYABLE_ROWS.has(entry[0]),
    });
  }

  appendSectionHeader(parent, "Light client");
  renderInfoRow(
    parent,
    "@parity/truapi-provider",
    buildLightClientVersionLabel(),
  );

  const { polkadotApi, parityTruapi } = packageVersions();
  if (polkadotApi.length > 0) {
    appendSectionHeader(parent, "@polkadot-api");
    for (const pkg of polkadotApi) {
      renderInfoRow(parent, pkg.name, pkg.version);
    }
  }
  if (parityTruapi.length > 0) {
    appendSectionHeader(parent, "@parity/truapi");
    for (const pkg of parityTruapi) {
      renderInfoRow(parent, pkg.name, pkg.version);
    }
  }

  const actionsRow = document.createElement("div");
  actionsRow.className = "mode-cache-row mode-diag-links-row";

  const shareBtn = document.createElement("button");
  shareBtn.type = "button";
  shareBtn.className = "mode-clear-btn";
  shareBtn.textContent = "Share diagnostic";
  shareBtn.title =
    "Open a new issue on paritytech/dotli pre-filled with these diagnostics";

  const debugBtn = document.createElement("button");
  debugBtn.type = "button";
  debugBtn.className = "mode-clear-btn";
  debugBtn.textContent = debugOn ? "Exit debug mode" : "Open in debug mode";
  debugBtn.title = debugOn
    ? "Reload this tab with the TrUAPI debug panel disabled"
    : "Reload this tab with the TrUAPI debug panel enabled (off again on tab close)";

  actionsRow.appendChild(shareBtn);
  actionsRow.appendChild(debugBtn);
  parent.appendChild(actionsRow);
}

function appendSectionHeader(
  parent: HTMLElement,
  text: string,
  modifier?: string,
): void {
  const header = document.createElement("div");
  header.className =
    modifier === undefined
      ? "mode-popover-section"
      : `mode-popover-section ${modifier}`;
  header.textContent = text;
  parent.appendChild(header);
}

function renderInfoRow(
  parent: HTMLElement,
  label: string,
  value: string,
  options: { copyable?: boolean } = {},
): void {
  const row = document.createElement("div");
  row.className = "mode-endpoint-row mode-info-row";
  const labelEl = document.createElement("span");
  labelEl.className = "mode-endpoint-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("code");
  valueEl.className = "mode-endpoint-value";
  valueEl.textContent = value;
  row.appendChild(labelEl);
  row.appendChild(valueEl);
  parent.appendChild(row);
  if (options.copyable === true) {
    row.classList.add("mode-info-row-copyable");
    row.title = `Click to copy ${label}`;
  }
}

function buildRadioRow(
  name: string,
  opts: {
    value: string;
    label: string;
    description: string;
    selected: boolean;
    disabled?: boolean;
  },
): HTMLLabelElement {
  const row = document.createElement("label");
  const disabled = opts.disabled === true;
  row.className = `mode-radio-row${opts.selected ? " selected" : ""}${disabled ? " disabled" : ""}`;

  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = name;
  radio.value = opts.value;
  radio.checked = opts.selected;
  radio.disabled = disabled;
  radio.className = "mode-radio-input";
  row.appendChild(radio);

  const dot = document.createElement("span");
  dot.className = "mode-radio-dot";
  row.appendChild(dot);

  const text = document.createElement("span");
  text.className = "mode-radio-text";
  const labelEl = document.createElement("span");
  labelEl.className = "mode-radio-label";
  labelEl.textContent = opts.label;
  const descEl = document.createElement("span");
  descEl.className = "mode-radio-desc";
  descEl.textContent = opts.description;
  text.append(labelEl, descEl);
  row.appendChild(text);

  return row;
}

function renderCacheToggle(
  parent: HTMLElement,
  label: string,
  checked: boolean,
): void {
  const row = document.createElement("div");
  row.className = "mode-cache-row";

  const nameEl = document.createElement("span");
  nameEl.className = "mode-cache-label";
  nameEl.textContent = label;
  row.appendChild(nameEl);

  const toggle = document.createElement("button");
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-label", label);

  const track = document.createElement("span");
  track.className = "permissions-toggle-track";
  const knob = document.createElement("span");
  knob.className = "permissions-toggle-knob";
  track.appendChild(knob);
  toggle.appendChild(track);

  toggle.className = `permissions-popover-toggle ${checked ? "on" : ""}`;
  toggle.setAttribute("aria-checked", String(checked));

  row.appendChild(toggle);
  parent.appendChild(row);
}
