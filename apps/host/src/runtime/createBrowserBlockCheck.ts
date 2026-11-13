// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The first time a product is on show in a page load, shows each permission dot.li grants it that the browser blocks.

import { createReporter, defineCount } from '@dotli/metrics';
import { createAsyncTaskPool } from '@dotli/shared';
import type { ReadableAtom } from 'nanostores';
import type { BlockingModalScope } from './createBlockingModalCoordinator.js';
import { isBrowserBlocked, type BrowserPermissions } from './createBrowserPermissions.js';
import type { PermissionAuthorizations } from './createPermissionAuthorizations.js';
import type { HostPrompts } from './hostPrompts.js';
import { isPermissionGranted, type EnforceablePermissionName, type PermissionStatus } from './permissionPolicy.js';
import { resolveBrowserBlock } from './resolveBrowserBlock.js';
import type { ProductPermissions } from './state/productPermissions.js';
import type { ProductState } from './state/productState.js';

type Params = {
  /** The product on show. */
  products: ReadableAtom<ProductState>;
  /** The statuses dot.li holds for a product. */
  statuses: PermissionAuthorizations['getStatuses'];
  browser: Pick<BrowserPermissions, 'read' | 'request' | 'checked'>;
  /** The page's modal queue, which the blocked dialogs wait in. */
  scope: Pick<BlockingModalScope, 'enqueue'>;
  prompts: Pick<HostPrompts, 'askBrowserBlock'>;
  /** Stores the denial when the user restricts the product. */
  record: ProductPermissions['recordPromptDecision'];
};

const report = createReporter({ flow: 'permissions' });

/** A launch check that failed to read a product's statuses or to store a restriction. */
const browserCheckMetric = defineCount<'error'>('permissions.browser_check');

/** Checks each product once per page load, the first time it is on show. */
export function createBrowserBlockCheck({ products, statuses, browser, scope, prompts, record }: Params) {
  const checked = new Set<string>();
  // One check at a time, so the dialogs of one product are queued before the next product's.
  const checks = createAsyncTaskPool({ poolSize: 1 });

  async function check(label: string): Promise<void> {
    let found: PermissionStatus[];
    try {
      found = await statuses(label, browser.checked);
    } catch (error) {
      // The next time the product is on show checks it again.
      checked.delete(label);
      report.expected(error, { step: 'browser_block_check', metric: browserCheckMetric });
      return;
    }
    const granted = browser.checked.filter((_, index) => {
      const status = found[index];
      return status !== undefined && isPermissionGranted(status);
    });
    const read = await Promise.all(granted.map(name => browser.read(name)));
    const blocked = granted.filter((_, index) => {
      const status = read[index];
      return status !== undefined && isBrowserBlocked(status);
    });
    try {
      for (const permission of blocked) {
        await scope.enqueue(signal => settleBlock(label, permission, signal));
      }
    } catch (error) {
      // The scope was disposed, which ends its dialogs.
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      report.expected(error, { step: 'browser_block_check', metric: browserCheckMetric });
    }
  }

  /** Stores a restriction within the dialog's turn, so the modal slot stays held until the denial is written. */
  async function settleBlock(label: string, permission: EnforceablePermissionName, signal: AbortSignal): Promise<void> {
    const resolution = await resolveBrowserBlock({ label, permission, signal, prompts, browser });
    switch (resolution) {
      case 'restricted':
        await record({ label, name: permission, decision: 'denied', signal });
        return;
      case 'allowed':
      case 'kept':
        return;
    }
  }

  return {
    /** Checks each product that loads from now on, until the returned stop. */
    start(): () => void {
      return products.listen(state => {
        switch (state.status) {
          case 'none':
          case 'error':
            return;
          case 'loaded':
            break;
        }
        if (checked.has(state.label)) {
          return;
        }
        checked.add(state.label);
        void checks.call(() => check(state.label));
      });
    },
  };
}
