// Core callbacks keep "Allow once" for the current execution; host-mediated input uses it for one request.
// A grant gated by the iframe `allow` attribute reloads into a new execution, which would drop it.
// Auto-grants answer `AllowOnce` so the core records nothing the user never saw.

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
import { mediaOwnsCapture } from '../media-host.js';

// Legacy HTML products have no host interception point for independent HTTP/WS/RTC.
// Protected Media containers separately deny all product-side raw capture.
function gatedRemotePermissionName(tag: RemotePermission['tag']): EnforceablePermissionName | null {
  switch (tag) {
    case 'ChainSubmit':
    case 'PreimageSubmit':
    case 'StatementSubmit':
      return tag;
    case 'Remote':
    case 'WebRtc':
    case 'Calling':
      return null;
  }
}

export function createPromptPermission(
  label: string,
  modalScope: BlockingModalScope = createBlockingModalScope(),
  limiter: SubmitRateLimiter = createSubmitRateLimiter(),
): Permissions {
  const devicePermission: Permissions['devicePermission'] = async (_product, tag) => {
    // A protected Media container never receives raw capture; the host owns it.
    // Refuse by error, never `Deny`: the core would persist a durable device
    // denial on the same key host Media consent reads, disabling calls.
    if (mediaOwnsCapture(label) && (tag === 'Camera' || tag === 'Microphone')) {
      throw new Error(ERRORS.MEDIA_RAW_CAPTURE_REFUSED);
    }
    // OpenUrl has no host-side enforcement point; auto-grant rather than show
    // a modal whose deny button cannot block the underlying browser API.
    if (!isEnforceableDevicePermission(tag)) {
      return 'AllowOnce';
    }
    return decidePromptPermission(label, tag, { kind: 'Device', limiter }, modalScope);
  };

  const remotePermission: Permissions['remotePermission'] = async (_product, request) => {
    // Calling consent is operation-scoped through the host Media backend.
    if (request.permission.tag === 'Calling') {
      return 'Deny';
    }
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
  // Core callbacks must return the decision without an administrative write, which would invalidate
  // their pending prompt. Host-mediated consumers without a core prompt commit durable answers themselves.
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
