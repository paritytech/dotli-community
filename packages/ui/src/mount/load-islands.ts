// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Loads the shell's islands after boot. The prerendered shell hydrates fully
// static (mount/hydrate-shell.tsx); its reactive pieces (the theme toggle,
// ...) come from one lazily loaded chunk, components/shell/islands.tsx,
// which client-renders each and swaps it in for its static markup. Keeping
// them off the startup bundle is the point, so everything here is Solid-free.

import { captureException } from "@dotli/metrics/sentry";
import type * as Islands from "../components/shell/islands";

/**
 * The islands' triggers: the static buttons users can click before the
 * islands mount, which do nothing on their own. Each must be an `#id`
 * selector (comma-separated): a held click is replayed by looking its
 * target's id up again, on the live element that replaced it.
 */
const TRIGGERS = "#theme-toggle";

/** How long to wait before the one retry of a failed chunk load. */
const RETRY_DELAY_MS = 1000;

const importIslands = (): Promise<typeof Islands> =>
  import("../components/shell/islands");

let loading: Promise<void> | null = null;

/**
 * Import the islands chunk and mount the islands, once; called by the host
 * right after hydrateShell(). Never rejects.
 *
 * Until the islands mount, a click on a trigger is held back (its default
 * prevented) and replayed on the live trigger afterwards, at most once per
 * trigger, so an early click is not lost. A failed chunk load is retried
 * once, after about a second, with clicks still held back. When the retry
 * fails too, or mounting the islands throws, the static shell stays, the
 * failure is reported to Sentry once (`islands_load_error` or
 * `islands_mount_error`) and nothing is replayed.
 */
export function ensureIslands(): Promise<void> {
  if (loading !== null) {
    return loading;
  }
  const pending = new Set<string>();
  const holdBack = (ev: MouseEvent): void => {
    const trigger =
      ev.target instanceof Element ? ev.target.closest(TRIGGERS) : null;
    if (trigger !== null) {
      ev.preventDefault();
      pending.add(trigger.id);
    }
  };
  const stopHoldingBack = (): void => {
    document.removeEventListener("click", holdBack, true);
  };
  document.addEventListener("click", holdBack, true);
  loading = importIslands()
    .catch(() =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, RETRY_DELAY_MS);
      }).then(importIslands),
    )
    .then(
      ({ mountIslands }) => {
        stopHoldingBack();
        try {
          mountIslands();
        } catch (err) {
          captureException(err, { kind: "islands_mount_error" });
          return;
        }
        for (const id of pending) {
          document.getElementById(id)?.click();
        }
      },
      (err: unknown) => {
        stopHoldingBack();
        captureException(err, { kind: "islands_load_error" });
      },
    );
  return loading;
}
