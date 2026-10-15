// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The core keeps "Allow once" for the current execution, so it is offered only where the core is the
// gate. A grant gated by the iframe `allow` attribute reloads the product into a new execution, which
// would drop it. Auto-grants answer `AllowOnce` so the core records nothing the user never saw.

import { withActiveTld } from '@dotli/config';
import type { PermissionDecision, Permissions } from '@parity/truapi-host';
import type { RemotePermission } from '@parity/truapi';
import {
  isDevicePermission,
  isEnforceableDevicePermission,
  type EnforceablePermissionName,
  type PermissionAuthorizations,
} from '../permissions.js';
import { throwIfAborted, type BlockingModalScope } from '../blocking-modal-queue.js';
import { createSubmitRateLimiter, type SubmitRateLimiter } from './rate-limit.js';
import type { Notify } from './push-notification.js';
import { ERRORS } from '../errors.js';
import type { ProductPermissions } from '../state/product-permissions.js';
import type { HostPrompts } from '../host-prompts.js';

// The host cannot enforce `Remote` (HTTP/WS) or `WebRtc`, since the sandbox cannot reliably intercept either. A prompt
// would offer a choice the host could not keep, so both are auto-granted.
function gatedRemotePermissionName(tag: RemotePermission['tag']): EnforceablePermissionName | null {
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

/** The page's permissions, which a prompt reads before it asks and records the answer in. */
export interface PromptPermissionStores {
  /** The core's permission store, whose status decides whether the user is asked at all. */
  registry: Pick<PermissionAuthorizations, 'status'>;
  /** The product's permissions, which show the answer in the menu and rebuild the frame for a device grant. */
  product: Pick<ProductPermissions, 'recordPromptDecision'>;
}

export interface PromptPermissionDeps {
  ask: HostPrompts['askPermission'];
  notify: Notify;
  permissions: PromptPermissionStores;
  /** Shared by device and remote prompts. */
  limiter?: SubmitRateLimiter | undefined;
}

export function createPromptPermission(
  label: string,
  { ask, notify, permissions, limiter = createSubmitRateLimiter() }: PromptPermissionDeps,
  modalScope: BlockingModalScope,
): Permissions {
  const options = { limiter, ask, notify, permissions };
  const devicePermission: Permissions['devicePermission'] = async (_product, tag) => {
    // OpenUrl has no host-side enforcement point, so a deny button could not block it.
    if (!isEnforceableDevicePermission(tag)) {
      return 'AllowOnce';
    }
    return decidePromptPermission(label, tag, { kind: 'Device', ...options }, modalScope);
  };

  const remotePermission: Permissions['remotePermission'] = async (_product, request) => {
    const name = gatedRemotePermissionName(request.permission.tag);
    if (name === null) {
      return 'AllowOnce';
    }
    return decidePromptPermission(label, name, { kind: 'Remote', ...options }, modalScope);
  };

  return { devicePermission, remotePermission };
}

interface PromptOptions {
  kind: 'Device' | 'Remote';
  limiter: { allow: () => boolean };
  ask: HostPrompts['askPermission'];
  notify: Notify;
  permissions: PromptPermissionStores;
}

function decidePromptPermission(
  label: string,
  name: EnforceablePermissionName,
  options: PromptOptions,
  modalScope: BlockingModalScope,
): Promise<PermissionDecision> {
  return modalScope.enqueue(signal => decidePromptPermissionWhenActive(label, name, options, signal));
}

async function decidePromptPermissionWhenActive(
  label: string,
  name: EnforceablePermissionName,
  options: PromptOptions,
  signal: AbortSignal,
): Promise<PermissionDecision> {
  const { kind, limiter, ask, notify, permissions } = options;
  // A grant reloads the product.
  const gatedByIframe = isDevicePermission(name);
  const status = await permissions.registry.status(label, name);
  throwIfAborted(signal);
  if (status === 'granted') {
    // The status also reflects a pending one-time grant, which AllowAlways would quietly make permanent.
    return 'AllowOnce';
  }
  if (status === 'denied') {
    notify({
      label: withActiveTld(label),
      text:
        kind === 'Device'
          ? `${name} access is blocked. Use the permissions menu in the top bar to change this.`
          : 'Transaction signing is blocked. Use the permissions menu in the top bar to change this.',
      tone: 'idle',
      dismissMs: 6000,
      browserNotification: false,
    });
    return 'Deny';
  }
  if (!limiter.allow()) {
    throw new Error(ERRORS.PERMISSION_PROMPT_RATE_LIMITED);
  }
  const decision = await ask(label, name, signal, {
    allowOnce: !gatedByIframe,
  });
  throwIfAborted(signal);
  if (decision === 'dismissed') {
    throw new Error(ERRORS.PERMISSION_DIALOG_DISMISSED);
  }
  await permissions.product.recordPromptDecision(label, name, decision, signal);
  if (decision === 'denied') {
    return 'Deny';
  }
  return decision === 'granted-once' ? 'AllowOnce' : 'AllowAlways';
}
