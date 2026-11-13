// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Settles a grant the browser blocks: the user restricts the app, closes the dialog, or fixes the browser and retries.

import type { BrowserPermissions, BrowserPermissionStatus } from './createBrowserPermissions.js';
import type { HostPrompts } from './hostPrompts.js';
import type { EnforceablePermissionName } from './permissionPolicy.js';
import { throwIfModalAborted } from './throwIfModalAborted.js';

/** How the user settled a browser block. `kept` leaves the grant as it is. */
export type BrowserBlockResolution = 'restricted' | 'allowed' | 'kept';

type Params = {
  /** The product whose grant the browser blocks. */
  label: string;
  permission: EnforceablePermissionName;
  /** Ends the dialog. */
  signal: AbortSignal;
  prompts: Pick<HostPrompts, 'askBrowserBlock'>;
  browser: Pick<BrowserPermissions, 'read' | 'request'>;
};

/**
 * Shows the blocked dialog until the user settles it, again after each Retry the browser still blocks. Rejects with the
 * modal's AbortError once `signal` aborts.
 */
export async function resolveBrowserBlock({
  label,
  permission,
  signal,
  prompts,
  browser,
}: Params): Promise<BrowserBlockResolution> {
  for (let retried = false; ; retried = true) {
    // An object, so TypeScript keeps the type the Retry click widens it to.
    const retry: { request: Promise<BrowserPermissionStatus> | null } = { request: null };
    const answer = await prompts.askBrowserBlock({
      label,
      permission,
      signal,
      retried,
      onRetry() {
        // The browser prompts only within the click, so it is asked here rather than after the answer settles.
        retry.request = browser.request(permission);
      },
    });
    switch (answer) {
      case 'restrict':
        return 'restricted';
      case 'dismissed':
        return 'kept';
      case 'retry':
        break;
    }
    const status = await (retry.request ?? browser.read(permission));
    throwIfModalAborted(signal);
    switch (status) {
      case 'denied':
        continue;
      case 'granted':
      case 'prompt':
      case 'unknown':
        return 'allowed';
    }
  }
}
