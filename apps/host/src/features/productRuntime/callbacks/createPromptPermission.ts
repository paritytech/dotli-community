// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The core keeps "Allow once" for the current execution. Auto-grants answer `AllowOnce` so the core records nothing the
// user never saw, and so does a device whose consent is the browser's own prompt.

import { withActiveTld } from '@dotli/config';
import type { PermissionDecision, Permissions, ProductContext } from '@parity/truapi-host';
import type { HostDevicePermissionRequest, RemotePermissionRequest } from '@parity/truapi';
import type { BrowserPermissions, BrowserPermissionStatus } from '../../permissions/index.js';
import { isBrowserBlocked } from '../../permissions/index.js';
import type { PermissionAuthorizations } from '../../permissions/index.js';
import type { EnforceablePermissionName, PermissionStatus } from '../../permissions/index.js';
import { throwIfModalAborted } from '../../../kit/throwIfModalAborted.js';
import { createSubmitRateLimiter } from './createSubmitRateLimiter.js';
import type { CoreContext } from '../core/createPageCore.js';
import { ERRORS } from '../../../kit/errors.js';
import type { ProductPermissions } from '../../permissions/index.js';
import { servedRequests, type ServeRule } from './servedRequests.js';
import { getLastingStatus, isGranted, toPermissionDecision, type HostPrompts } from '../../permissions/index.js';
import { isRestricted, resolveBrowserBlock } from '../../permissions/index.js';

/** The page's permissions, which a prompt reads before it asks and records the answer in. */
export type PromptPermissionStores = {
  /** The core's permission store, whose status decides whether the user is asked at all. */
  registry: Pick<PermissionAuthorizations, 'getStatus'>;
  /** The product's permissions, which show the answer in the menu and rebuild the frame for a device grant. */
  product: Pick<ProductPermissions, 'recordPromptDecision'>;
};

type Params = {
  /** The core the prompts speak for, and whose queue on the page's one coordinator they wait in. */
  core: Pick<CoreContext, 'product' | 'blockingModalScope'>;
  /**
   * Shows the permission dialog, the dialog that the browser blocks a device grant, and the notice that a stored denial
   * blocks the permission.
   */
  prompts: Pick<HostPrompts, 'askPermission' | 'askBrowserBlock' | 'notify'>;
  /** The stored statuses a prompt reads first and the store its answer is recorded in. */
  permissions: PromptPermissionStores;
  /**
   * The browser's own permissions, asked in the click that allows a device permission and read where it is not asked,
   * or where the browser's prompt is the consent.
   */
  browser: Pick<BrowserPermissions, 'read' | 'request'>;
};

/** One permission the core asks about. */
type PromptRequest = {
  name: EnforceablePermissionName;
  /** Whether the core asks for a device or a remote permission, which picks the blocked notice's text. */
  kind: 'Device' | 'Remote';
};

/**
 * Answers the core's device and remote permission asks from the stored status, or else by asking the user in the
 * page's prompt queue. A device whose consent is the browser's own prompt is allowed once with no dialog, and one the
 * host no longer offers is denied with no dialog. Rejects when
 * the prompts go past the rate limit, the user dismisses the dialog, the browser blocks such a device
 * (`ERRORS.BROWSER_BLOCKED_DEVICE`), or the permission guards a request this host does not serve.
 */
export function createPromptPermission({ core, prompts, permissions, browser }: Params): Permissions {
  const { label } = core.product;
  // Shared by device and remote prompts.
  const limiter = createSubmitRateLimiter();

  async function devicePermission(
    _product: ProductContext,
    tag: HostDevicePermissionRequest,
  ): Promise<PermissionDecision> {
    return answerFromRule(servedRequests.getDeviceRule(tag), 'Device');
  }

  async function remotePermission(
    _product: ProductContext,
    request: RemotePermissionRequest,
  ): Promise<PermissionDecision> {
    return answerFromRule(servedRequests.getRemoteRule(request.permission.tag), 'Remote');
  }

  async function answerFromRule(rule: ServeRule, kind: PromptRequest['kind']): Promise<PermissionDecision> {
    switch (rule.kind) {
      case 'grant':
        return 'AllowOnce';
      case 'deny':
        return 'Deny';
      case 'refuse':
        throw new Error(ERRORS.UNSERVED_REQUEST);
      case 'browser':
        return answerForBrowser(rule.name);
      case 'prompt':
        return decidePromptPermission({ name: rule.name, kind });
    }
  }

  /**
   * The browser's own prompt is the consent, so no dialog shows and the product hears at once. Rejects with
   * `ERRORS.BROWSER_BLOCKED_DEVICE` when the browser blocks `name`.
   */
  async function answerForBrowser(name: EnforceablePermissionName): Promise<PermissionDecision> {
    if (isBrowserBlocked(await browser.read(name))) {
      // A rejection, unlike Deny, is not stored, so the user's choice stays with the browser.
      throw new Error(ERRORS.BROWSER_BLOCKED_DEVICE);
    }
    return 'AllowOnce';
  }

  /** Only a question waits for the dialog queue. A stored answer needs no dialog, so it never waits behind one. */
  async function decidePromptPermission(request: PromptRequest): Promise<PermissionDecision> {
    const stored = answerFromStoredStatus(request, await permissions.registry.getStatus(label, request.name));
    return stored ?? core.blockingModalScope.enqueue(signal => decidePromptPermissionWhenActive(request, signal));
  }

  function answerFromStoredStatus({ name, kind }: PromptRequest, status: PermissionStatus): PermissionDecision | null {
    switch (status) {
      case 'granted':
        // The status also reflects a pending one-time grant, which AllowAlways would quietly make permanent.
        return 'AllowOnce';
      case 'denied':
        prompts.notify({
          label: withActiveTld(label),
          text: getBlockedText(kind, name),
          tone: 'idle',
          dismissMs: 6000,
          browserNotification: false,
        });
        return 'Deny';
      case 'ask':
        return null;
    }
  }

  async function decidePromptPermissionWhenActive(
    request: PromptRequest,
    signal: AbortSignal,
  ): Promise<PermissionDecision> {
    const { name } = request;
    // An earlier prompt for the same permission may have answered it while this one waited.
    const status = await permissions.registry.getStatus(label, name);
    throwIfModalAborted(signal);
    const stored = answerFromStoredStatus(request, status);
    if (stored !== null) {
      return stored;
    }
    if (!limiter.allow()) {
      throw new Error(ERRORS.PERMISSION_PROMPT_RATE_LIMITED);
    }
    // An object, so TypeScript keeps the type the approving click widens it to.
    const approval: { request: Promise<BrowserPermissionStatus> | null } = { request: null };
    const answer = await prompts.askPermission({
      label,
      permission: name,
      signal,
      onApprove() {
        // The browser prompts only within the click, so it is asked here rather than after the answer settles.
        approval.request = browser.request(name);
      },
    });
    throwIfModalAborted(signal);
    // A permission the browser has no say over, a remote one included, is never blocked.
    if (isGranted(answer)) {
      const resolution = await resolveBrowserBlock({
        label,
        permission: name,
        known: approval.request,
        signal,
        prompts,
        browser,
        record: permissions.product.recordPromptDecision,
      });
      if (isRestricted(resolution)) {
        // Allowed once or for good, a restriction has stored a lasting denial.
        return 'Deny';
      }
    }
    const lasting = getLastingStatus(answer);
    // The core keeps a one-time grant for this execution itself, so only a lasting answer is recorded.
    if (lasting !== null) {
      await permissions.product.recordPromptDecision({ label, name, decision: lasting, signal });
    }
    return toPermissionDecision(answer);
  }

  return { devicePermission, remotePermission };
}

function getBlockedText(kind: PromptRequest['kind'], name: EnforceablePermissionName): string {
  switch (kind) {
    case 'Device':
      return `${name} access is blocked. Use the permissions menu in the top bar to change this.`;
    case 'Remote':
      return 'Transaction signing is blocked. Use the permissions menu in the top bar to change this.';
  }
}
