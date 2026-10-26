// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Labels are recorded on `<label>.<BASE_DOMAIN>` but shown on the landing origin, so the list lives in the
// cross-subdomain shared store. `localStorage` is a mirror for when that store is unreachable.

import { reportExpected, spans as S } from '@dotli/metrics';
import { createAsyncTaskPool, pageLocalStorage } from '@dotli/shared';
import { isValidDotLabel } from '@dotli/resolver';
import { getSharedChannel, type SharedChannel } from './runtime/shared-mode.js';

const RECENT_KEY = 'dotli_recent';
const MAX_RECENT = 8;

/** Drops anything that isn't a usable label, from the shared store or the mirror alike. */
export function parseRecentLabels(raw: string | null): string[] {
  if (raw === null || raw === '') {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((l): l is string => typeof l === 'string' && isValidDotLabel(l)).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function serializeRecentLabels(labels: string[]): string {
  return JSON.stringify(labels.slice(0, MAX_RECENT));
}

function withRecentLabel(labels: string[], label: string): string[] {
  return [label, ...labels.filter(l => l !== label)].slice(0, MAX_RECENT);
}

/** The recently visited names, over one shared store. */
export type RecentLabels = {
  /** An absent shared key is seeded from the mirror, so an upgrading device keeps its list. */
  load: () => Promise<string[]>;
  /** Only call this after a successful resolution. */
  record: (label: string) => Promise<void>;
  forget: (label: string) => Promise<void>;
};

/** A closed set, so the metric's `reason` tag stays bounded. */
type SharedFailure = 'read' | 'write' | 'migrate';

// An unreachable shared store is the environment's failure, and the mirror carries the list meanwhile.
function reportSharedFailure(err: unknown, reason: SharedFailure, message: string): void {
  reportExpected(err, { flow: 'storage', step: 'recent_labels', metric: S.RECENT_LABELS_UPDATE, reason, message });
}

/** This origin's copy of the list, kept for when the shared store is unreachable. */
export type RecentMirror = {
  read: () => string[];
  write: (labels: string[]) => void;
};

/** This origin's copy of the list in `storage`, kept for when the shared store is unreachable. */
export function storageMirror(storage: Pick<Storage, 'getItem' | 'setItem'>): RecentMirror {
  return {
    read: () => parseRecentLabels(storage.getItem(RECENT_KEY)),
    write: labels => {
      storage.setItem(RECENT_KEY, serializeRecentLabels(labels));
    },
  };
}

const localMirror: RecentMirror = storageMirror(pageLocalStorage);

export function createRecentLabels(channel: SharedChannel, mirror: RecentMirror = localMirror): RecentLabels {
  // Each update reads, changes and writes the whole list, so two at once would drop one of them.
  const updates = createAsyncTaskPool({ poolSize: 1 });

  // Read-modify-write, so a visit recorded on one subdomain does not clobber one from another.
  const update = (next: (labels: string[]) => string[]): Promise<void> =>
    updates.call(async () => {
      let current: string[];
      try {
        current = parseRecentLabels(await channel.read(RECENT_KEY));
      } catch (err: unknown) {
        // Keep the mirror moving so the list still works while the shared store is unreachable.
        reportSharedFailure(err, 'read', '[dot.li recent] Shared read failed; updating the per-origin mirror:');
        current = mirror.read();
      }
      const updated = next(current);
      mirror.write(updated);
      try {
        await channel.write(RECENT_KEY, serializeRecentLabels(updated));
      } catch (err: unknown) {
        reportSharedFailure(err, 'write', '[dot.li recent] Shared write failed:');
      }
    });

  // In the updates pool, so a visit recorded meanwhile builds on the seeded list. Seeds only a key still absent, so a
  // second load's seed or an update that ran first is never overwritten.
  const seed = (labels: string[]): Promise<void> =>
    updates.call(async () => {
      try {
        if ((await channel.read(RECENT_KEY)) === null) {
          await channel.write(RECENT_KEY, serializeRecentLabels(labels));
        }
      } catch (err: unknown) {
        reportSharedFailure(err, 'migrate', '[dot.li recent] Migration write failed:');
      }
    });

  return {
    load: async () => {
      let raw: string | null;
      try {
        raw = await channel.read(RECENT_KEY);
      } catch (err: unknown) {
        reportSharedFailure(err, 'read', '[dot.li recent] Shared read failed; using per-origin mirror:');
        return mirror.read();
      }

      if (raw === null) {
        const mirrored = mirror.read();
        if (mirrored.length > 0) {
          void seed(mirrored);
        }
        return mirrored;
      }

      const labels = parseRecentLabels(raw);
      mirror.write(labels);
      return labels;
    },
    record: async label => {
      if (!isValidDotLabel(label)) {
        return;
      }
      await update(labels => withRecentLabel(labels, label));
    },
    forget: label => update(labels => labels.filter(l => l !== label)),
  };
}

/** One list for the page, built on first use, so every change on the page queues behind the one before. */
export function createLazyRecentLabels(
  channel: () => SharedChannel,
  mirror: RecentMirror = localMirror,
): () => RecentLabels {
  let recents: RecentLabels | null = null;
  return () => {
    recents ??= createRecentLabels(channel(), mirror);
    return recents;
  };
}

/** The page's list over its shared store. */
const pageRecentLabels: () => RecentLabels = createLazyRecentLabels(getSharedChannel);

/** A window's own view and its top-level one. */
export type FrameView = {
  self: unknown;
  top: unknown;
};

/**
 * The list a landing island shows when it is handed none: the page's own, or none on a page inside another frame.
 * dot.li does not start there, so its read would wait out the configure timeout of a protocol frame nothing configures.
 */
export function landingRecentLabels(
  view: FrameView,
  list: () => RecentLabels = pageRecentLabels,
): RecentLabels | undefined {
  return view.self === view.top ? list() : undefined;
}

/** Records a resolved name on this page's shared store. */
export function recordRecentLabel(label: string): Promise<void> {
  return pageRecentLabels().record(label);
}
