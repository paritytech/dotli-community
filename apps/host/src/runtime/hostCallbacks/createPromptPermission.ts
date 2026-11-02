// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The core keeps "Allow once" for the current execution, so it is offered only where the core is the
// gate. A grant gated by the iframe `allow` attribute reloads the product into a new execution, which
// would drop it. Auto-grants answer `AllowOnce` so the core records nothing the user never saw.

import { withActiveTld } from '@dotli/config';
import type { PermissionDecision, Permissions, ProductContext } from '@parity/truapi-host';
import type { HostDevicePermissionRequest, RemotePermission, RemotePermissionRequest } from '@parity/truapi';
import type { PermissionAuthorizations } from '../createPermissionAuthorizations.js';
import {
  isDevicePermission,
  isEnforceableDevicePermission,
  type EnforceablePermissionName,
  type PermissionStatus,
} from '../permissionPolicy.js';
import type { BlockingModalScope } from '../createBlockingModalCoordinator.js';
import { throwIfModalAborted } from '../throwIfModalAborted.js';
import { createSubmitRateLimiter, type SubmitRateLimiter } from './createSubmitRateLimiter.js';
import type { Notify } from './createNotificationAdapters.js';
import { ERRORS } from '../errors.js';
import type { ProductPermissions } from '../state/productPermissions.js';
import type { HostPrompts, PermissionPromptDecision } from '../hostPrompts.js';

/** The page's permissions, which a prompt reads before it asks and records the answer in. */
export type PromptPermissionStores = {
  /** The core's permission store, whose status decides whether the user is asked at all. */
  registry: Pick<PermissionAuthorizations, 'getStatus'>;
  /** The product's permissions, which show the answer in the menu and rebuild the frame for a device grant. */
  product: Pick<ProductPermissions, 'recordPromptDecision'>;
};

type Params = {
  /** The product the prompts speak for. */
  label: string;
  /** Shows the permission dialog and settles with the user's decision. */
  ask: HostPrompts['askPermission'];
  /** Shows the notice that a stored denial blocks the permission. */
  notify: Notify;
  /** The stored statuses a prompt reads first and the store its answer is recorded in. */
  permissions: PromptPermissionStores;
  /** Shared by device and remote prompts. */
  limiter?: SubmitRateLimiter | undefined;
  /** Where the prompts queue, on the page's one coordinator. */
  modalScope: BlockingModalScope;
};

/** One permission the core asks about, with what deciding it reads, asks and records. */
type PromptRequest = Omit<Params, 'limiter' | 'modalScope'> & {
  /** The permission asked about. */
  name: EnforceablePermissionName;
  /** Whether the core asks for a device or a remote permission, which picks the blocked notice's text. */
  kind: 'Device' | 'Remote';
  /** Shared by device and remote prompts. */
  limiter: SubmitRateLimiter;
};

/** An answer the product's permissions keep. */
type LastingPromptDecision = Exclude<PermissionPromptDecision, 'dismissed' | 'granted-once'>;

/**
 * Answers the core's device and remote permission asks from the stored status, or else by asking the user in the
 * page's prompt queue. Rejects when the prompts go past the rate limit or the user dismisses the dialog.
 */
export function createPromptPermission({
  label,
  ask,
  notify,
  permissions,
  limiter = createSubmitRateLimiter(),
  modalScope,
}: Params): Permissions {
  const options = { label, limiter, ask, notify, permissions };

  async function devicePermission(
    _product: ProductContext,
    tag: HostDevicePermissionRequest,
  ): Promise<PermissionDecision> {
    // OpenUrl has no host-side enforcement point, so a deny button could not block it.
    if (!isEnforceableDevicePermission(tag)) {
      return 'AllowOnce';
    }
    return decidePromptPermission({ ...options, name: tag, kind: 'Device' }, modalScope);
  }

  async function remotePermission(
    _product: ProductContext,
    request: RemotePermissionRequest,
  ): Promise<PermissionDecision> {
    const name = getGatedRemotePermissionName(request.permission.tag);
    if (name === null) {
      return 'AllowOnce';
    }
    return decidePromptPermission({ ...options, name, kind: 'Remote' }, modalScope);
  }

  return { devicePermission, remotePermission };
}

// The host cannot enforce `Remote` (HTTP/WS) or `WebRtc`, since the sandbox cannot reliably intercept either. A prompt
// would offer a choice the host could not keep, so both are auto-granted.
function getGatedRemotePermissionName(tag: RemotePermission['tag']): EnforceablePermissionName | null {
  switch (tag) {
    case 'ChainSubmit':
    case 'PreimageSubmit':
    case 'StatementSubmit':
      return tag;
    case 'Remote':
    case 'WebRtc':
      return null;
  }
}

/** Only a question waits for the dialog queue. A stored answer needs no dialog, so it never waits behind one. */
async function decidePromptPermission(
  request: PromptRequest,
  modalScope: BlockingModalScope,
): Promise<PermissionDecision> {
  const { label, name, permissions } = request;
  const stored = answerFromStoredStatus(request, await permissions.registry.getStatus(label, name));
  return stored ?? modalScope.enqueue(signal => decidePromptPermissionWhenActive(request, signal));
}

function answerFromStoredStatus(
  { label, name, kind, notify }: PromptRequest,
  status: PermissionStatus,
): PermissionDecision | null {
  switch (status) {
    case 'granted':
      // The status also reflects a pending one-time grant, which AllowAlways would quietly make permanent.
      return 'AllowOnce';
    case 'denied':
      notify({
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

function getBlockedText(kind: PromptRequest['kind'], name: EnforceablePermissionName): string {
  switch (kind) {
    case 'Device':
      return `${name} access is blocked. Use the permissions menu in the top bar to change this.`;
    case 'Remote':
      return 'Transaction signing is blocked. Use the permissions menu in the top bar to change this.';
  }
}

async function decidePromptPermissionWhenActive(
  request: PromptRequest,
  signal: AbortSignal,
): Promise<PermissionDecision> {
  const { label, name, limiter, ask, permissions } = request;
  // A grant reloads the product.
  const gatedByIframe = isDevicePermission(name);
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
  const decision = await ask({ label, permission: name, signal, allowOnce: !gatedByIframe });
  throwIfModalAborted(signal);
  if (decision === 'dismissed') {
    throw new Error(ERRORS.PERMISSION_DIALOG_DISMISSED);
  }
  // The core keeps a one-time grant for this execution itself, so only a lasting answer is recorded.
  if (decision === 'granted-once') {
    return 'AllowOnce';
  }
  await permissions.product.recordPromptDecision({ label, name, decision, signal });
  return getLastingDecision(decision);
}

function getLastingDecision(decision: LastingPromptDecision): PermissionDecision {
  switch (decision) {
    case 'granted':
      return 'AllowAlways';
    case 'denied':
      return 'Deny';
  }
}
