// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Loads the shell's islands after boot. The prerendered shell is static HTML
// that no client code hydrates; its reactive pieces (listed in
// mountIslands()) come from one lazily loaded chunk,
// components/shell/islands.tsx, which client-renders each and swaps it in
// for its static markup. Keeping them off the startup bundle is the point,
// so everything here is Solid-free.

import { captureException } from "@dotli/metrics/sentry";
import { disableAuthModal } from "../auth-controller";
import { topbarStore } from "../state/topbar";

/**
 * The islands' triggers: the static buttons users can click before the
 * islands mount, which do nothing on their own. Each must be an `#id`
 * selector (comma-separated): a held click is replayed by looking its
 * target's id up again, on the live element that replaced it.
 */
const TRIGGERS =
  "#theme-toggle, #permissions-button, #chains-button, #mode-button, #more-button";

let loading: Promise<void> | null = null;

/**
 * When the offline-banner island did not replace the static `#offline-banner`
 * (the chunk failed to load, mounting threw, or the banner island failed),
 * drive the static banner the way the island would: shown while offline and
 * the topbar is visible. Being offline at boot is the likeliest reason the
 * chunk failed. A swapped-out static banner is left alone, so the island and
 * this never both drive a banner.
 */
function followOfflineWithoutIslands(banner: HTMLElement | null): void {
  if (banner?.isConnected !== true) {
    return;
  }
  const update = (): void => {
    banner.style.display =
      !navigator.onLine && topbarStore.get().visible ? "block" : "none";
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  topbarStore.subscribe(update);
  update();
}

/**
 * Import the islands chunk and mount the islands, once; called by the host
 * at boot (apps/host/src/boot.ts). Never rejects.
 *
 * Until the islands mount, a click on a trigger is held back (its default
 * prevented), and the last one is replayed once on the live trigger
 * afterwards, with its `detail` (0 for a key's click, which opens a menu on
 * its first item), so an early click is not lost. Only the last: replaying
 * several would open several surfaces at once, a menu among them. Each
 * island mounts on its own (mountIslands reports one that fails and goes
 * on). When the chunk cannot
 * load, or mountIslands itself throws, the static shell stays, the failure
 * is reported to Sentry (`islands_load_error` or `islands_mount_error`) and
 * nothing is replayed. Whenever the banner island is not mounted, the static
 * offline banner still follows the connection, and whenever the auth-modal
 * island is not mounted, the auth modal is disabled (disableAuthModal), so
 * a login never holds the blocking-modal lease for a modal nobody can see.
 *
 * A failed load is not retried: browsers cache a failed module fetch, so a
 * second import() of the same chunk fails at once without refetching.
 */
export function ensureIslands(): Promise<void> {
  if (loading !== null) {
    return loading;
  }
  /** The last held-back click: its trigger's id and its `detail`. */
  let pending: { id: string; detail: number } | null = null;
  const holdBack = (ev: MouseEvent): void => {
    const trigger =
      ev.target instanceof Element ? ev.target.closest(TRIGGERS) : null;
    if (trigger !== null) {
      ev.preventDefault();
      pending = { id: trigger.id, detail: ev.detail };
    }
  };
  const stopHoldingBack = (): void => {
    document.removeEventListener("click", holdBack, true);
  };
  document.addEventListener("click", holdBack, true);
  const staticBanner = (): HTMLElement | null =>
    document.getElementById("offline-banner");
  loading = import("../components/shell/islands").then(
    ({ mountIslands }) => {
      stopHoldingBack();
      const banner = staticBanner();
      // An island that fails after it was swapped in has its static markup
      // back by now: fall back for it as for one that failed to mount.
      const onLateFailure = (name: string): void => {
        if (name === "auth-modal") {
          disableAuthModal();
        } else if (name === "offline-banner") {
          followOfflineWithoutIslands(banner);
        }
      };
      try {
        if (mountIslands(onLateFailure).includes("auth-modal")) {
          disableAuthModal();
        }
      } catch (err) {
        captureException(err, { kind: "islands_mount_error" });
        disableAuthModal();
        return;
      } finally {
        followOfflineWithoutIslands(banner);
      }
      if (pending !== null) {
        document.getElementById(pending.id)?.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            composed: true,
            detail: pending.detail,
          }),
        );
      }
    },
    (err: unknown) => {
      stopHoldingBack();
      captureException(err, { kind: "islands_load_error" });
      disableAuthModal();
      followOfflineWithoutIslands(staticBanner());
    },
  );
  return loading;
}
