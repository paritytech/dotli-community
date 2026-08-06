// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Recently-visited labels
//
// A label is recorded once it resolves, which happens on
// `<label>.<BASE_DOMAIN>`, but the pills are rendered on the bare landing
// origin. Those are different origins, so per-origin `localStorage` can't
// carry the list between them. The list therefore lives in the same
// cross-subdomain store the mode preferences use (the
// `host.<BASE_DOMAIN>` iframe in production, the preview server's HTTP
// store on localhost).
//
// Every write is a read-modify-write against that store so a visit
// recorded on one subdomain doesn't clobber one recorded on another.
// `localStorage` stays a mirror: it is what the landing page falls back to
// when the shared store is unreachable (iframe blocked, preview down).

import {
  RECENT_KEY,
  getRecentLabels,
  parseRecentLabels,
  serializeRecentLabels,
  withRecentLabel,
  writeRecentLabels,
} from "@dotli/storage/cid-cache";
import { isValidDotLabel } from "@dotli/shared/html";
import { log } from "@dotli/shared/log";
import { getSharedChannel } from "./shared-mode";

/**
 * Read the shared list, falling back to this origin's mirror.
 *
 * An absent shared key is seeded from the mirror so a device upgrading from
 * the pre-shared-store build keeps its list. An empty one is left alone.
 */
export async function loadRecentLabels(): Promise<string[]> {
  const channel = getSharedChannel();
  let raw: string | null;
  try {
    raw = await channel.read(RECENT_KEY);
  } catch (err: unknown) {
    log.warn(
      "[dot.li recent] Shared read failed; using per-origin mirror:",
      err instanceof Error ? err.message : err,
    );
    return getRecentLabels();
  }

  if (raw === null) {
    const mirror = getRecentLabels();
    if (mirror.length > 0) {
      void channel
        .write(RECENT_KEY, serializeRecentLabels(mirror))
        .catch((err: unknown) => {
          log.warn(
            "[dot.li recent] Migration write failed:",
            err instanceof Error ? err.message : err,
          );
        });
    }
    return mirror;
  }

  const labels = parseRecentLabels(raw);
  // Warm mirror for a later boot that can't reach the shared store.
  writeRecentLabels(labels);
  return labels;
}

/** Record a resolved label. Only call this after a successful resolution. */
export async function recordRecentLabel(label: string): Promise<void> {
  if (!isValidDotLabel(label)) {
    return;
  }
  await updateRecentLabels((labels) => withRecentLabel(labels, label));
}

/** Drop a label, both from the shared store and this origin's mirror. */
export async function forgetRecentLabel(label: string): Promise<void> {
  await updateRecentLabels((labels) => labels.filter((l) => l !== label));
}

async function updateRecentLabels(
  next: (labels: string[]) => string[],
): Promise<void> {
  const channel = getSharedChannel();
  let current: string[];
  try {
    current = parseRecentLabels(await channel.read(RECENT_KEY));
  } catch {
    // Unreachable shared store. Keep the mirror moving so the list still
    // works on whichever origin is up.
    current = getRecentLabels();
  }
  const updated = next(current);
  writeRecentLabels(updated);
  try {
    await channel.write(RECENT_KEY, serializeRecentLabels(updated));
  } catch (err: unknown) {
    log.warn(
      "[dot.li recent] Shared write failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
