// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's islands: its reactive pieces, loaded lazily after boot by
// mount/load-islands.ts. Shell.tsx keeps every piece's static markup, which
// is prerendered and hydrated as it is; here each island is client-rendered
// into a detached container and swapped in for those static nodes by id,
// wherever they are now (the landing page, ui.ts, moves the theme nodes out
// of `#shell`).
//
// An island's root container is that detached element, so Solid's delegated
// events (onClick, ...) would listen on a node outside the document: islands
// wire their events with native listeners in callback refs. ESLint rejects
// `on*` JSX props under components/shell/ (packages/ui/eslint.config.js).

import type { JSX } from "@solidjs/web";
import { disposeRoot, mountRoot, reportRootErrorOnce } from "../../mount/root";
import { AuthButton } from "./AuthButton";
import { AuthModal } from "./AuthModal";
import { ChainsPopover } from "./ChainsPopover";
import { OfflineBanner } from "./OfflineBanner";
import { PermissionsPopover } from "./PermissionsPopover";
import { SettingsPopover } from "./SettingsPopover";
import { ThemeToggle } from "./ThemeToggle";
import { UrlPill } from "./UrlPill";
import { UserPopover } from "./UserPopover";

/** What a browser can focus (hidden and inert elements aside). */
const FOCUSABLE =
  "a[href],area[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),iframe,summary,[tabindex],[contenteditable]";

/** The child indexes that lead from `ancestor` down to `el`. */
function childPath(ancestor: Element, el: Element): number[] {
  const path: number[] = [];
  for (let node = el; node !== ancestor;) {
    const parent = node.parentElement;
    if (parent === null) {
      return [];
    }
    path.unshift([...parent.children].indexOf(node));
    node = parent;
  }
  return path;
}

/**
 * Move focus from `focused`, inside `stale`, into its replacement `fresh`.
 * Static and live markup match node for node, so the target is the element
 * with the focused element's id or, without an id, the one at the same child
 * path; failing that, the first focusable element of `fresh`. Only elements
 * a browser can focus are tried, each until one takes focus (a hidden one
 * does not), so an unfocusable replacement leaves focus where it falls.
 */
function carryFocus(focused: Element, stale: Element, fresh: Element): void {
  const same =
    focused.id === ""
      ? childPath(stale, focused).reduce<Element | undefined>(
          (node, index) => node?.children[index],
          fresh,
        )
      : fresh.id === focused.id
        ? fresh
        : fresh.querySelector(`[id="${focused.id}"]`);
  const candidates = [same, fresh, ...fresh.querySelectorAll(FOCUSABLE)];
  for (const el of candidates) {
    if (
      (el instanceof HTMLElement || el instanceof SVGElement) &&
      el.matches(FOCUSABLE)
    ) {
      el.focus();
      if (document.activeElement === el) {
        return;
      }
    }
  }
}

/**
 * Render `view` as the root `island:<name>` and swap each of its top-level
 * elements, identified by `ids`, in for the static element with the same
 * id. The swap happens in one go, so there is never a moment with two
 * elements per id or with half an island. If the island fails to render
 * (reported by mountRoot) or an id is missing on either side (reported here
 * as `island_missing_node`), the static nodes stay and the island is
 * unmounted. Focus inside a static node moves into its replacement (see
 * carryFocus). Returns whether the island was swapped in.
 */
function mountIsland(
  name: string,
  view: () => JSX.Element,
  ids: string[],
): boolean {
  const container = document.createElement("div");
  const dispose = mountRoot(`island:${name}`, container, view);
  const pairs: [stale: Element, fresh: Element][] = [];
  for (const id of ids) {
    const stale = document.getElementById(id);
    const fresh = container.querySelector(`[id="${id}"]`);
    if (stale === null || fresh === null) {
      // An island that rendered nothing failed to render, which mountRoot
      // has already reported.
      if (container.hasChildNodes()) {
        reportRootErrorOnce(
          new Error(
            `[islands] island:${name} has no #${id} on the ${stale === null ? "page" : "island"}`,
          ),
          `island:${name}`,
          { kind: "island_missing_node" },
        );
      }
      dispose();
      return false;
    }
    pairs.push([stale, fresh]);
  }
  const focused = document.activeElement;
  let refocus: [focused: Element, stale: Element, fresh: Element] | null = null;
  for (const [stale, fresh] of pairs) {
    if (focused !== null && stale.contains(focused)) {
      refocus = [focused, stale, fresh];
    }
    stale.replaceWith(fresh);
  }
  if (refocus !== null) {
    carryFocus(...refocus);
  }
  return true;
}

/**
 * Mount `name` with mountIsland, on its own: a throw that escapes the
 * island's error boundary is reported (`island_mount_error`), leaves its
 * static nodes in place (unless the throw came mid-swap) and does not stop
 * the other islands. Returns whether the island was swapped in.
 */
function mountIsolated(
  name: string,
  view: () => JSX.Element,
  ids: string[],
): boolean {
  try {
    return mountIsland(name, view, ids);
  } catch (err) {
    reportRootErrorOnce(err, `island:${name}`, { kind: "island_mount_error" });
    disposeRoot(`island:${name}`);
    return false;
  }
}

/**
 * Mount every shell island over its static markup. Returns the names of the
 * islands that failed to mount (already reported), so the loader can fall
 * back for them.
 */
export function mountIslands(): string[] {
  const failed: string[] = [];
  const mount = (
    name: string,
    view: () => JSX.Element,
    ids: string[],
  ): void => {
    if (!mountIsolated(name, view, ids)) {
      failed.push(name);
    }
  };
  mount("theme", () => <ThemeToggle />, ["theme-toggle", "theme-popover"]);
  // The URL bar element itself is swapped (main.ts only checks that
  // `#topbar-url` exists and writes the url-pill store, never the element).
  mount("url-pill", () => <UrlPill />, ["topbar-url"]);
  mount("offline-banner", () => <OfflineBanner />, ["offline-banner"]);
  // The static auth button stays disabled until this swap (it is none of
  // the loader's click triggers). The popover and the modal render the auth
  // stores, which the eager auth controller has kept since boot.
  mount("auth-button", () => <AuthButton />, ["auth-button"]);
  mount("user-popover", () => <UserPopover />, ["user-popover"]);
  mount("auth-modal", () => <AuthModal />, ["auth-modal-backdrop"]);
  // The static permissions button is enabled, so a click on it before this
  // swap is held back and replayed by the loader (one of its triggers).
  mount("permissions", () => <PermissionsPopover />, [
    "permissions-button",
    "permissions-popover-backdrop",
    "permissions-popover",
  ]);
  // Also a loader trigger. The static button is shown or not by the host
  // (setChainsButtonVisible) until this swap; the island reads the store
  // that call also writes.
  mount("chains", () => <ChainsPopover />, ["chains-button", "chains-popover"]);
  // Also a loader trigger, and the mobile "More" menu's Settings row
  // forwards its tap to it. The popover renders the settings store the host
  // seeds at boot.
  mount("settings", () => <SettingsPopover />, [
    "mode-button",
    "mode-popover-backdrop",
    "mode-popover",
  ]);
  return failed;
}
