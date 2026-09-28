// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The markup the imperative topbar.ts produced for the permissions button,
// backdrop and popover before they became an island (commit 650a9df9):
// Shell.tsx's static markup, changed by the same writes initPermissions,
// setPermissionsPopoverOpen, renderPermissionsPopoverAsync and
// createPermissionDropdown made. The island tests compare against it node
// for node.

import { PERM_ICONS } from "@dotli/ui/components/shell/PermissionRow";
import { ALL_PERMISSIONS, type PermissionStatus } from "@dotli/ui/permissions";
import { query } from "../../support";

const STATIC_BUTTON = `<button id="permissions-button" class="topbar-btn" title="Permissions" aria-label="Permissions"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></button>`;

const STATIC_BACKDROP = `<div class="permissions-popover-backdrop" id="permissions-popover-backdrop"></div>`;

const STATIC_POPOVER = `<div class="permissions-popover" id="permissions-popover"><div class="permissions-popover-header">Permissions</div><div class="permissions-popover-list" id="permissions-popover-list"></div></div>`;

const STATUS_LABELS: Record<PermissionStatus, string> = {
  ask: "Ask (Default)",
  granted: "Allowed",
  denied: "Denied",
};

const STATUS_ORDER: readonly PermissionStatus[] = ["ask", "granted", "denied"];

function fromHtml(html: string): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.firstElementChild as HTMLElement;
}

/** The button after initPermissions (and setPermissionsPopoverOpen). */
export function oldPermissionsButton(opts: {
  open: boolean;
  hasGrants: boolean;
}): HTMLElement {
  const button = fromHtml(STATIC_BUTTON);
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", String(opts.open));
  button.setAttribute("aria-controls", "permissions-popover");
  if (opts.hasGrants) {
    button.classList.add("has-grants");
  }
  return button;
}

export function oldPermissionsBackdrop(open: boolean): HTMLElement {
  const backdrop = fromHtml(STATIC_BACKDROP);
  if (open) {
    backdrop.classList.add("open");
  }
  return backdrop;
}

function footer(text: string): HTMLElement {
  const hint = document.createElement("div");
  hint.className = "permissions-popover-footer";
  hint.textContent = text;
  return hint;
}

/** createPermissionDropdown's listbox, as a click on the select opened it. */
function menuFor(
  perm: (typeof ALL_PERMISSIONS)[number],
  currentStatus: PermissionStatus,
): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "permissions-popover-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", `${perm.label} permission`);
  for (const status of STATUS_ORDER) {
    const item = document.createElement("button");
    item.type = "button";
    const selected = status === currentStatus;
    item.className = `permissions-popover-menu-item${selected ? " selected" : ""}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(selected));
    const text = document.createElement("span");
    text.textContent = STATUS_LABELS[status];
    item.appendChild(text);
    if (selected) {
      const check = document.createElement("span");
      check.className = "permissions-popover-menu-check";
      check.innerHTML =
        '<svg viewBox="0 0 12 10" width="12" height="10" aria-hidden="true">' +
        '<path d="M1 5l3.5 3.5L11 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      item.appendChild(check);
    }
    menu.appendChild(item);
  }
  return menu;
}

/** One row as renderPermissionsPopoverAsync and createPermissionDropdown built it. */
function row(
  perm: (typeof ALL_PERMISSIONS)[number],
  status: PermissionStatus,
  menuOpen: boolean,
): HTMLElement {
  const el = document.createElement("div");
  el.className = "permissions-popover-row";

  const icon = document.createElement("span");
  icon.className = "permissions-popover-icon";
  icon.innerHTML = PERM_ICONS[perm.name] ?? "";
  el.appendChild(icon);

  const nameEl = document.createElement("span");
  nameEl.className = "permissions-popover-name";
  nameEl.id = `permissions-popover-name-${perm.name}`;
  nameEl.textContent = perm.label;
  el.appendChild(nameEl);

  const wrap = document.createElement("div");
  wrap.className = "permissions-popover-select-wrap";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "permissions-popover-select";
  trigger.id = `permissions-popover-select-${perm.name}`;
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", String(menuOpen));
  const triggerLabel = document.createElement("span");
  triggerLabel.className = "permissions-popover-select-label";
  triggerLabel.id = `permissions-popover-status-${perm.name}`;
  triggerLabel.textContent = STATUS_LABELS[status];
  trigger.appendChild(triggerLabel);
  trigger.setAttribute(
    "aria-labelledby",
    `permissions-popover-name-${perm.name} ${triggerLabel.id}`,
  );
  const caret = document.createElement("span");
  caret.className = "permissions-popover-select-caret";
  caret.innerHTML =
    '<svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">' +
    '<path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  trigger.appendChild(caret);
  wrap.appendChild(trigger);
  if (menuOpen) {
    wrap.appendChild(menuFor(perm, status));
  }
  el.appendChild(wrap);
  return el;
}

export type OldPermissionsList =
  | { kind: "empty" }
  | { kind: "hint"; text: string }
  | {
      kind: "rows";
      /** Per permission name; a missing one is "ask". */
      statuses: Partial<Record<string, PermissionStatus>>;
      /** The permission whose dropdown is open. */
      menuOpen?: string;
    };

/** The popover after initPermissions and a render of its list. */
export function oldPermissionsPopover(opts: {
  open: boolean;
  list: OldPermissionsList;
}): HTMLElement {
  const popover = fromHtml(STATIC_POPOVER);
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Permissions");
  popover.tabIndex = -1;
  if (opts.open) {
    popover.classList.add("open");
  }
  const list = query(popover, "#permissions-popover-list", Element);
  const { list: content } = opts;
  if (content.kind === "hint") {
    list.appendChild(footer(content.text));
  } else if (content.kind === "rows") {
    for (const perm of ALL_PERMISSIONS) {
      list.appendChild(
        row(
          perm,
          content.statuses[perm.name] ?? "ask",
          content.menuOpen === perm.name,
        ),
      );
    }
    list.appendChild(footer("Changing permissions will reload the app."));
  }
  return popover;
}
