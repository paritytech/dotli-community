// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Labels are recorded on `<label>.<BASE_DOMAIN>` but shown on the landing origin, so the list lives in the
// cross-subdomain shared store. `localStorage` is a mirror for when that store is unreachable.

import {
  RECENT_KEY,
  getRecentLabels,
  parseRecentLabels,
  serializeRecentLabels,
  withRecentLabel,
  writeRecentLabels,
} from '@dotli/storage';
import { isValidDotLabel, log } from '@dotli/shared';

import { getSharedChannel } from './shared-mode.js';

/** An absent shared key is seeded from the mirror, so an upgrading device keeps its list. */
export async function loadRecentLabels(): Promise<string[]> {
  const channel = getSharedChannel();
  let raw: string | null;
  try {
    raw = await channel.read(RECENT_KEY);
  } catch (err: unknown) {
    log.warn('[dot.li recent] Shared read failed; using per-origin mirror:', err);
    return getRecentLabels();
  }

  if (raw === null) {
    const mirror = getRecentLabels();
    if (mirror.length > 0) {
      void channel.write(RECENT_KEY, serializeRecentLabels(mirror)).catch((err: unknown) => {
        log.warn('[dot.li recent] Migration write failed:', err);
      });
    }
    return mirror;
  }

  const labels = parseRecentLabels(raw);
  writeRecentLabels(labels);
  return labels;
}

/** Only call this after a successful resolution. */
export async function recordRecentLabel(label: string): Promise<void> {
  if (!isValidDotLabel(label)) {
    return;
  }
  await updateRecentLabels(labels => withRecentLabel(labels, label));
}

export async function forgetRecentLabel(label: string): Promise<void> {
  await updateRecentLabels(labels => labels.filter(l => l !== label));
}

// Read-modify-write, so a visit recorded on one subdomain does not clobber one from another.
async function updateRecentLabels(next: (labels: string[]) => string[]): Promise<void> {
  const channel = getSharedChannel();
  let current: string[];
  try {
    current = parseRecentLabels(await channel.read(RECENT_KEY));
  } catch {
    // Keep the mirror moving so the list still works while the shared store is unreachable.
    current = getRecentLabels();
  }
  const updated = next(current);
  writeRecentLabels(updated);
  try {
    await channel.write(RECENT_KEY, serializeRecentLabels(updated));
  } catch (err: unknown) {
    log.warn('[dot.li recent] Shared write failed:', err);
  }
}
