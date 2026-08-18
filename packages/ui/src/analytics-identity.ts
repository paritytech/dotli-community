// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li anonymous analytics identity
//
// `initSentry` mints the id from per-origin `localStorage`, because it runs
// before anything that can throw and cannot wait on an async read. Every app
// gets its own subdomain, so that alone gives one person a separate id per app
// and inflates every user-level number in Sentry.
//
// The id therefore lives in the same cross-subdomain store the mode
// preferences and recent labels use (the `host.<BASE_DOMAIN>` iframe in
// production, the preview server's HTTP store on localhost). `localStorage`
// stays a mirror, so a boot that cannot reach the shared store still reports a
// stable id rather than a fresh one.
//
// First visit to a new subdomain still starts on the local id and switches once
// the shared read lands. From the second boot the mirror already agrees, so
// there is nothing to switch.

import {
  ANALYTICS_USER_KEY,
  adoptAnalyticsUser,
  getAnalyticsUser,
} from "@dotli/metrics/sentry";
import { log } from "@dotli/shared/log";
import { getSharedChannel } from "./shared-mode";

let reconciled = false;

/**
 * Point this origin's analytics id at the shared one.
 *
 * Idempotent. Adopts the shared id when there is one, otherwise seeds the
 * shared store from this origin so the next app to boot adopts it instead.
 */
export async function reconcileAnalyticsUser(): Promise<void> {
  if (reconciled) {
    return;
  }
  reconciled = true;

  const local = getAnalyticsUser();
  if (local === null) {
    // `initSentry` always records an id when it can, so an absent one means
    // either this build strips analytics or localStorage is unavailable.
    // Neither is fixable here, and skipping saves an iframe round-trip.
    return;
  }

  const channel = getSharedChannel();
  let shared: string | null;
  try {
    shared = await channel.read(ANALYTICS_USER_KEY);
  } catch (err: unknown) {
    log.warn(
      "[dot.li analytics] Shared read failed, keeping the per-origin id:",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  if (shared !== null && shared !== "") {
    if (shared !== local) {
      adoptAnalyticsUser(shared);
    }
    return;
  }

  // Nothing shared yet. Promote whatever this origin already has so the id
  // that wins is the first one recorded, not the last app to boot.
  try {
    await channel.write(ANALYTICS_USER_KEY, local);
  } catch (err: unknown) {
    log.warn(
      "[dot.li analytics] Shared write failed, id stays per-origin:",
      err instanceof Error ? err.message : err,
    );
  }
}
