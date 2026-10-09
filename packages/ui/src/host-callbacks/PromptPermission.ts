// The core keeps "Allow once" for the current execution, so it is offered only where the core is the
// gate. A grant gated by the iframe `allow` attribute reloads the product into a new execution, which
// would drop it. Auto-grants answer `AllowOnce` so the core records nothing the user never saw.

import { withActiveTld } from '@dotli/config';
import type { PermissionDecision, Permissions } from '@parity/truapi-host';
import type { RemotePermission } from '@parity/truapi';
import {
  getPermissionStatus,
  isDevicePermission,
  isEnforceableDevicePermission,
  type EnforceablePermissionName,
} from '../permissions.js';
import { showPermissionRequestModal } from '../permission-modal.js';
import { showNotification } from '../notification.js';
import { createBlockingModalScope, throwIfAborted, type BlockingModalScope } from '../blocking-modal-queue.js';
import { createSubmitRateLimiter, type SubmitRateLimiter } from './rate-limit.js';
import { ERRORS } from '../errors.js';
import { recordPermissionChange } from '../state/permissions.js';

// WebRtc is gated by the iframe `allow` attribute and `Remote` (HTTP/WS) cannot be intercepted
// reliably from the sandbox, so both are auto-granted.
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

export function createPromptPermission(
  label: string,
  modalScope: BlockingModalScope = createBlockingModalScope(),
  limiter: SubmitRateLimiter = createSubmitRateLimiter(),
): Permissions {
  const devicePermission: Permissions['devicePermission'] = async (_product, tag) => {
    // OpenUrl has no host-side enforcement point, so a deny button could not block it.
    if (!isEnforceableDevicePermission(tag)) {
      return 'AllowOnce';
    }
    return decidePromptPermission(label, tag, { kind: 'Device', limiter }, modalScope);
  };

  const remotePermission: Permissions['remotePermission'] = async (_product, request) => {
    const name = gatedRemotePermissionName(request.permission.tag);
    if (name === null) {
      return 'AllowOnce';
    }
    return decidePromptPermission(label, name, { kind: 'Remote', limiter }, modalScope);
  };

  return { devicePermission, remotePermission };
}

interface PromptOptions {
  kind: 'Device' | 'Remote';
  limiter: { allow: () => boolean };
  gatedByIframe?: boolean;
}

export function decidePromptPermission(
  label: string,
  name: EnforceablePermissionName,
  options: PromptOptions,
  modalScope: BlockingModalScope = createBlockingModalScope(),
): Promise<PermissionDecision> {
  return modalScope.enqueue(signal => decidePromptPermissionWhenActive(label, name, options, signal));
}

async function decidePromptPermissionWhenActive(
  label: string,
  name: EnforceablePermissionName,
  options: PromptOptions,
  signal: AbortSignal,
): Promise<PermissionDecision> {
  const { kind, limiter, gatedByIframe = isDevicePermission(name) } = options;
  // Grants enforced by the iframe `allow` attribute require a reload.
  const status = await getPermissionStatus(label, name);
  throwIfAborted(signal);
  if (status === 'granted') {
    // The status also reflects a pending one-time grant, which AllowAlways would quietly make permanent.
    return 'AllowOnce';
  }
  if (status === 'denied') {
    showNotification({
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
  const decision = await showPermissionRequestModal(label, name, signal, {
    allowOnce: !gatedByIframe,
  });
  throwIfAborted(signal);
  if (decision === 'dismissed') {
    throw new Error(ERRORS.PERMISSION_DIALOG_DISMISSED);
  }
  // The core commits the returned decision against the prompt's original authority.
  // An administrative settings write here would invalidate that very prompt.
  if (decision === 'denied') {
    return 'Deny';
  }
  if (gatedByIframe) {
    // The iframe `allow` attribute is fixed at load, so reload, a tick later so the prompt response
    // flushes before the iframe is disposed.
    setTimeout(() => {
      if (signal.aborted) {
        return;
      }
      recordPermissionChange({ kind: 'device', label, permission: name });
    }, 0);
  } else {
    // Keeps the permissions button in sync.
    recordPermissionChange({ kind: 'grant', label, permission: name });
  }
  return decision === 'granted-once' ? 'AllowOnce' : 'AllowAlways';
}
