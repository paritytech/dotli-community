// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Settles a grant the browser may block: the user restricts the app, closes the dialog, or fixes the browser and retries.

import { isBrowserBlocked, type BrowserPermissions, type BrowserPermissionStatus } from './createBrowserPermissions.js';
import type { HostPrompts } from './hostPrompts.js';
import type { EnforceablePermissionName } from './permissionPolicy.js';
import type { ProductPermissions } from './state/productPermissions.js';
import { throwIfModalAborted } from './throwIfModalAborted.js';

/** How the user settled a browser block. `kept` leaves the grant as it is. */
export type BrowserBlockResolution = 'restricted' | 'allowed' | 'kept';

/** True when the user restricted the app rather than keep its grant. */
export function isRestricted(resolution: BrowserBlockResolution): boolean {
  switch (resolution) {
    case 'restricted':
      return true;
    case 'allowed':
    case 'kept':
      return false;
  }
}

type Params = {
  /** The product whose grant the browser may block. */
  label: string;
  permission: EnforceablePermissionName;
  /** The browser's status as already asked for or read, null to read it here. */
  known: Promise<BrowserPermissionStatus> | null;
  /** Ends the dialog. */
  signal: AbortSignal;
  prompts: Pick<HostPrompts, 'askBrowserBlock'>;
  browser: Pick<BrowserPermissions, 'read' | 'request'>;
  /** Stores the denial when the user restricts the product. */
  record: ProductPermissions['recordPromptDecision'];
};

/**
 * Resolves `allowed` once the browser does not block the permission, and until then shows the blocked dialog, again
 * after each Retry. Stores a lasting denial when the user restricts the product. Rejects with the modal's AbortError
 * once `signal` aborts, after the browser answers a request already made, and with the store's error when the denial
 * fails to save.
 */
export async function resolveBrowserBlock({
  label,
  permission,
  known,
  signal,
  prompts,
  browser,
  record,
}: Params): Promise<BrowserBlockResolution> {
  for (let retried = false, pending = known; ; retried = true) {
    const status = await (pending ?? browser.read(permission));
    throwIfModalAborted(signal);
    if (!isBrowserBlocked(status)) {
      return 'allowed';
    }
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
        await record({ label, name: permission, decision: 'denied', signal });
        return 'restricted';
      case 'dismissed':
        return 'kept';
      case 'retry':
        break;
    }
    pending = retry.request;
  }
}
