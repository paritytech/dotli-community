// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Labels are recorded on `<label>.<BASE_DOMAIN>` but shown on the landing origin, so the list lives in the
// cross-subdomain shared store. `localStorage` is a mirror for when that store is unreachable.

import { createReporter, defineCount } from '@dotli/metrics';
import { createAsyncTaskPool } from '@dotli/shared';
import { isValidDotLabel } from '@dotli/resolver';
import type { SharedChannel } from './runtime/sharedMode.js';
import { pageRecentMirror, type RecentMirror } from './createStorageMirror.js';
import { parseRecentLabels, serializeRecentLabels } from './parseRecentLabels.js';
import { RECENT_KEY } from './recentKey.js';

const report = createReporter({ flow: 'storage' });

/**
 * A failed read or write of the recently visited names in the shared store. Tagged `outcome` and `reason` (`read`,
 * `write` or `migrate`), as the list then lives in this origin only.
 */
const recentLabelsUpdateMetric = defineCount<'error'>('recent_labels.update');

/** The recently visited names, over one shared store. */
export type RecentLabels = ReturnType<typeof createRecentLabels>;

type Params = {
  /** The store every subdomain shares. */
  channel: Pick<SharedChannel, 'read' | 'write'>;
  /** This origin's copy, the page's local storage by default. */
  mirror?: RecentMirror | undefined;
};

type ReportSharedFailureParams = {
  error: unknown;
  /** A closed set, so the metric's `reason` tag stays bounded. */
  reason: 'read' | 'write' | 'migrate';
  message: string;
};

/**
 * Builds the list over `channel`, mirrored in `mirror`. A shared store failure is reported, and the mirror carries the
 * list meanwhile. Never throws.
 */
export function createRecentLabels({ channel, mirror = pageRecentMirror }: Params) {
  // Each update reads, changes and writes the whole list, so two at once would drop one of them.
  const updates = createAsyncTaskPool({ poolSize: 1 });

  // Read-modify-write, so a visit recorded on one subdomain does not clobber one from another.
  function update(next: (labels: string[]) => string[]): Promise<void> {
    return updates.call(async () => {
      let current: string[];
      try {
        current = parseRecentLabels(await channel.read(RECENT_KEY));
      } catch (error: unknown) {
        // Keep the mirror moving so the list still works while the shared store is unreachable.
        reportSharedFailure({
          error,
          reason: 'read',
          message: '[dot.li recent] Shared read failed; updating the per-origin mirror:',
        });
        current = mirror.read();
      }
      const updated = next(current);
      mirror.write(updated);
      try {
        await channel.write(RECENT_KEY, serializeRecentLabels(updated));
      } catch (error: unknown) {
        reportSharedFailure({ error, reason: 'write', message: '[dot.li recent] Shared write failed:' });
      }
    });
  }

  // In the updates pool, so a visit recorded meanwhile builds on the seeded list. Seeds only a key still absent, so a
  // second load's seed or an update that ran first is never overwritten.
  function seed(labels: string[]): Promise<void> {
    return updates.call(async () => {
      try {
        if ((await channel.read(RECENT_KEY)) === null) {
          await channel.write(RECENT_KEY, serializeRecentLabels(labels));
        }
      } catch (error: unknown) {
        reportSharedFailure({ error, reason: 'migrate', message: '[dot.li recent] Migration failed:' });
      }
    });
  }

  return {
    /**
     * Resolves the list, newest first. An absent shared key is seeded from the mirror, so an upgrading device keeps its
     * list. Rejects only as the mirror does.
     */
    async load(): Promise<string[]> {
      let raw: string | null;
      try {
        raw = await channel.read(RECENT_KEY);
      } catch (error: unknown) {
        reportSharedFailure({
          error,
          reason: 'read',
          message: '[dot.li recent] Shared read failed; using per-origin mirror:',
        });
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
    /**
     * Puts `label` first on the list, and ignores a label that is not a valid dot label. Only call this after a
     * successful resolution. Rejects only as the mirror does.
     */
    async record(label: string): Promise<void> {
      if (!isValidDotLabel(label)) {
        return;
      }
      await update(labels => [label, ...labels.filter(l => l !== label)]);
    },
    /** Takes `label` off the list. Rejects only as the mirror does. */
    forget: (label: string): Promise<void> => update(labels => labels.filter(l => l !== label)),
  };
}

// An unreachable shared store is the environment's failure, and the mirror carries the list meanwhile.
function reportSharedFailure({ error, reason, message }: ReportSharedFailureParams): void {
  report.expected(error, { step: 'recent_labels', metric: recentLabelsUpdateMetric, reason, message });
}
