// Core-owned prompts return a decision; Rust commits it against the permission
// revision captured before prompting. Writing the grant here would invalidate
// that compare-exchange and turn an approval into Permission denied.
//
// "Always allow" and "Deny" are durable. Generic permission grants appear in
// the topbar permissions menu; JAM peer decisions are keyed by product and
// genesis in the core. Submit and notification one-time grants are consumed
// by the next operation. A JAM peer one-time grant authorizes the running
// peer session. Iframe `allow`-gated permissions offer no one-time grant:
// granting reloads the product into a new execution.
// Auto-grants answer `AllowOnce` so the core records nothing the user never
// saw. Each instance serves one product, so the product the core passes is
// already known as `label`.

import { withActiveTld } from '@dotli/config';
import type { PermissionDecision, Permissions } from '@parity/truapi-host';
import type { RemotePermission } from '@parity/truapi';
import {
  getPermissionStatus,
  isDevicePermission,
  isEnforceableDevicePermission,
  setPermissionStatus,
  type EnforceablePermissionName,
} from '../permissions.js';
import { showJamPeersPermissionModal, showPermissionRequestModal } from '../permission-modal.js';
import { showNotification } from '../notification.js';
import { createBlockingModalScope, throwIfAborted, type BlockingModalScope } from '../blocking-modal-queue.js';
import { createSubmitRateLimiter, type SubmitRateLimiter } from './rate-limit.js';
import { ERRORS } from '../errors.js';
import { recordPermissionChange } from '../state/permissions.js';
import { mediaOwnsCapture } from '../media-host.js';

// Legacy HTML products have no host interception point for independent HTTP/WS/RTC.
// Protected Media containers separately deny all product-side raw capture.
// `JamPeers` carries its genesis and has its own prompt.
function gatedRemotePermissionName(
  tag: Exclude<RemotePermission['tag'], 'JamPeers'>,
): EnforceablePermissionName | null {
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
    return decidePromptPermission(label, tag, { kind: 'Device', limiter, commitOwner: 'core' }, modalScope);
  };

  const remotePermission: Permissions['remotePermission'] = async (_product, request) => {
    const { permission } = request;
    if (permission.tag === 'JamPeers') {
      return modalScope.enqueue(signal =>
        decideJamPeersPermission(label, permission.value.genesis, {
          limiter,
          signal,
        }),
      );
    }
    // Calling consent is operation-scoped through the host Media backend.
    if (permission.tag === 'Calling') {
      return 'Deny';
    }
    const name = gatedRemotePermissionName(permission.tag);
    if (name === null) {
      return 'AllowOnce';
    }
    return decidePromptPermission(label, name, { kind: 'Remote', limiter, commitOwner: 'core' }, modalScope);
  };

  return { devicePermission, remotePermission };
}

// The core asks only while the product's stored decision for this genesis is
// undetermined, and itself persists "Always allow" and "Deny" per product and
// genesis, so the next dial of that network in any execution is answered
// without a prompt. A dismissal stores nothing.
async function decideJamPeersPermission(
  label: string,
  genesis: string,
  options: { limiter: { allow: () => boolean }; signal: AbortSignal },
): Promise<PermissionDecision> {
  const { limiter, signal } = options;
  if (!limiter.allow()) {
    throw new Error(ERRORS.PERMISSION_PROMPT_RATE_LIMITED);
  }
  const decision = await showJamPeersPermissionModal(label, genesis, signal);
  throwIfAborted(signal);
  switch (decision) {
    case 'dismissed':
      throw new Error(ERRORS.PERMISSION_DIALOG_DISMISSED);
    case 'denied':
      return 'Deny';
    case 'granted':
      return 'AllowAlways';
    case 'granted-once':
      return 'AllowOnce';
  }
}

interface PromptOptions {
  kind: 'Device' | 'Remote';
  limiter: { allow: () => boolean };
  gatedByIframe?: boolean;
  /** Host-initiated operations have no enclosing core prompt commit. */
  commitOwner: 'core' | 'host';
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
    // The status also reflects a pending one-time grant, so answering
    // AllowAlways here would quietly make it permanent. AllowOnce leaves a
    // saved grant untouched.
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
  // status === "ask": show the modal and wait for the user.
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
  if (options.commitOwner === 'core') {
    return decision === 'denied' ? 'Deny' : decision === 'granted-once' ? 'AllowOnce' : 'AllowAlways';
  }
  if (decision === 'denied') {
    await setPermissionStatus(label, name, 'denied');
    throwIfAborted(signal);
    return 'Deny';
  }
  if (decision === 'granted') {
    await setPermissionStatus(label, name, 'granted');
    throwIfAborted(signal);
  }
  if (gatedByIframe) {
    // Device permissions are also gated by the iframe `allow` attribute,
    // which is fixed at iframe load time. Reload so the next attempt sees
    // the updated attribute. Defer to the next tick so the prompt response
    // can flush before the iframe is disposed.
    setTimeout(() => {
      if (signal.aborted) {
        return;
      }
      recordPermissionChange({ kind: 'device', label, permission: name });
    }, 0);
  } else {
    // No browser-level gate, so the grant takes effect as is. The event keeps
    // the permissions button in sync.
    recordPermissionChange({ kind: 'grant', label, permission: name });
  }
  return decision === 'granted-once' ? 'AllowOnce' : 'AllowAlways';
}
