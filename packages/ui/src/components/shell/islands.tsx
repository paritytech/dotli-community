// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell's islands: its reactive pieces, loaded lazily after boot by
// mount/load-islands.ts. Shell.tsx keeps every piece's static markup, which
// is prerendered into index.html as it is; here each island is client-rendered
// into a detached container and swapped in for those static nodes by id,
// wherever they are now (the landing page, components/landing/, moves the
// auth and theme nodes out of `#shell`). The loading screen is an island
// too, over the static screen apps/host/index.html paints in `#app` (see
// mountLoadingIsland).
//
// An island's root container is that detached element, so Solid's delegated
// events (onClick, ...) would listen on a node outside the document: islands
// wire their events with native listeners in callback refs. ESLint rejects
// `on*` JSX props under components/shell/ (packages/ui/eslint.config.js).

import type { JSX } from "@solidjs/web";
import { captureException } from "@dotli/metrics/sentry";
import { disposeAppRoot } from "../../mount/app-roots";
import { mountRoot } from "../../mount/root";
import { adoptLoadingScreen } from "../../loading-controller";
import { getLoadingState } from "../../state/loading";
import { FOCUSABLE, focusFirst } from "../focus";
import { AuthButton } from "./AuthButton";
import { AuthModal } from "./AuthModal";
import { ChainsPopover } from "./ChainsPopover";
import { LoadingScreen } from "./LoadingScreen";
import { MoreMenu } from "./MoreMenu";
import { OfflineBanner } from "./OfflineBanner";
import { PermissionsPopover } from "./PermissionsPopover";
import { SettingsPopover } from "./SettingsPopover";
import { ThemeToggle } from "./ThemeToggle";
import { UrlPill } from "./UrlPill";

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
  focusFirst(
    [same, fresh, ...fresh.querySelectorAll(FOCUSABLE)].filter(
      (el): el is HTMLElement | SVGElement =>
        (el instanceof HTMLElement || el instanceof SVGElement) &&
        el.matches(FOCUSABLE),
    ),
  );
}

/**
 * Render `view` as the root `island:<name>` and swap each of its top-level
 * elements, identified by `ids`, in for the static element with the same
 * id. The swap happens in one go, so there is never a moment with two
 * elements per id or with half an island. If the island fails to render
 * (reported by mountRoot) or an id is missing on either side (reported here
 * as `island_missing_node`), the static nodes stay and the island is
 * unmounted. Focus inside a static node moves into its replacement (see
 * carryFocus).
 *
 * An island that throws while rendering after it was swapped in cannot be
 * cleaned up by its error boundary: its nodes have left the container, and
 * the boundary either leaves them frozen in the page or takes them out,
 * leaving a hole. Once mountRoot has reported the error and disposed the
 * island, each static node goes back where its live one was, focus with it,
 * and `onLateFailure` hears the
 * island's name, so the loader can fall back as for an island that failed to
 * mount.
 * Returns whether the island was swapped in.
 */
function mountIsland(
  name: string,
  view: () => JSX.Element,
  ids: string[],
  onLateFailure?: (name: string) => void,
): boolean {
  const container = document.createElement("div");
  let swapped = false;
  let swapBack: (() => void) | null = null;
  const pairs: [stale: Element, fresh: Element][] = [];
  // Runs from inside the error boundary's fallback, while the live nodes are
  // still where the swap put them: the boundary may take them out of the page
  // right after. A marker keeps each one's place, and the focus is noted.
  // Returns the swap-back, to run once the island is disposed.
  const markPlaces = (): (() => void) => {
    const focused = document.activeElement;
    let refocus: [focused: Element, live: Element, back: Element] | null = null;
    const places: [marker: Comment, stale: Element, fresh: Element][] = [];
    for (const [stale, fresh] of pairs) {
      if (!fresh.isConnected) {
        continue;
      }
      if (focused !== null && fresh.contains(focused)) {
        refocus = [focused, fresh, stale];
      }
      const marker = document.createComment(`island:${name}`);
      fresh.before(marker);
      places.push([marker, stale, fresh]);
    }
    return () => {
      for (const [marker, stale, fresh] of places) {
        fresh.remove();
        marker.replaceWith(stale);
      }
      if (refocus !== null) {
        carryFocus(...refocus);
      }
    };
  };
  const dispose = mountRoot(`island:${name}`, container, view, {
    // A render error before the swap is handled below, synchronously.
    onError: () => {
      if (swapped) {
        swapBack = markPlaces();
      }
    },
    onBroken: () => {
      if (swapBack !== null) {
        swapBack();
        onLateFailure?.(name);
      }
    },
  });
  for (const id of ids) {
    const stale = document.getElementById(id);
    const fresh = container.querySelector(`[id="${id}"]`);
    if (stale === null || fresh === null) {
      // An island that rendered nothing failed to render, which mountRoot
      // has already reported.
      if (container.hasChildNodes()) {
        captureException(
          new Error(
            `[islands] island:${name} has no #${id} on the ${stale === null ? "page" : "island"}`,
          ),
          { root: `island:${name}`, kind: "island_missing_node" },
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
  swapped = true;
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
  onLateFailure?: (name: string) => void,
): boolean {
  try {
    return mountIsland(name, view, ids, onLateFailure);
  } catch (err) {
    captureException(err, {
      root: `island:${name}`,
      kind: "island_mount_error",
    });
    disposeAppRoot(`island:${name}`);
    return false;
  }
}

const LOADING_ID = "app-loading";

/**
 * Mount the loading screen island over the static screen from
 * apps/host/index.html, and make it the `"loading"` app root: disposing that
 * root (an error page, the product frame, the end of the dismiss fade) now
 * disposes the island and removes its node, where before it removed the
 * static screen. The root's timers still stop with it.
 *
 * Skipped when there is no screen left to take over: the static one is gone
 * (an error page, a direct iframe render or the landing page replaced it) or
 * the loading root was already disposed. Returns false only when mounting
 * failed, which leaves the static screen in place.
 */
export function mountLoadingIsland(
  onLateFailure?: (name: string) => void,
): boolean {
  const staticScreen = document.getElementById(LOADING_ID);
  if (staticScreen === null || getLoadingState().phase === "gone") {
    return true;
  }
  const mounted = mountIsolated(
    "loading",
    () => <LoadingScreen />,
    [LOADING_ID],
    onLateFailure,
  );
  if (mounted) {
    const screen = document.getElementById(LOADING_ID);
    adoptLoadingScreen(() => {
      disposeAppRoot("island:loading");
      screen?.remove();
      // Back in the page if the island failed late (see mountIsland).
      staticScreen.remove();
    });
  }
  return mounted;
}

/**
 * Mount every shell island over its static markup. Returns the names of the
 * islands that failed to mount (already reported), so the loader can fall
 * back for them. `onLateFailure` hears the name of an island that fails
 * later, after it was swapped in: by then its static markup is back (see
 * mountIsland), and the loader can fall back for it the same way.
 */
export function mountIslands(onLateFailure?: (name: string) => void): string[] {
  const failed: string[] = [];
  const mount = (
    name: string,
    view: () => JSX.Element,
    ids: string[],
  ): void => {
    if (!mountIsolated(name, view, ids, onLateFailure)) {
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
  mount("auth-button", () => <AuthButton />, ["auth-button", "user-popover"]);
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
  // Also a loader trigger. Its rows forward a tap to the buttons above by
  // id at click time, so they reach the live islands; the Chat row follows
  // the chat-panel store, which chat/panel.ts keeps from boot.
  mount("more", () => <MoreMenu />, ["more-button", "more-popover"]);
  // Not a loader trigger: nothing on it is clickable. The one island that is
  // also an app root (see mountLoadingIsland).
  if (!mountLoadingIsland(onLateFailure)) {
    failed.push("loading");
  }
  return failed;
}
