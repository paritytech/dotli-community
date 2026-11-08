// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The requests this browser core serves, and how the host answers each.

import type { HostDevicePermissionRequest, RemotePermission } from '@parity/truapi';
import type { UserConfirmationReview } from '@parity/truapi-host';
import { isEnforceableDevicePermission, type EnforceablePermissionName } from '../permissionPolicy.js';

/** How the host answers one permission: by asking the user, at once, or by refusing a request it does not serve. */
export type ServeRule = { kind: 'prompt'; name: EnforceablePermissionName } | { kind: 'grant' } | { kind: 'refuse' };

/** A review this host shows. The browser core serves no NFT purses. */
export type ServedReview = Exclude<UserConfirmationReview, { tag: 'NftPurseDrain' }>;

/** What this browser core serves, as the questions the code that prompts and confirms asks. */
export const servedRequests = { getDeviceRule, getRemoteRule, isServed };

/** How the host answers a device permission `tag`. Never throws. */
function getDeviceRule(tag: HostDevicePermissionRequest): ServeRule {
  // OpenUrl has no host-side enforcement point, so a deny button could not block it.
  if (!isEnforceableDevicePermission(tag)) {
    return { kind: 'grant' };
  }
  return { kind: 'prompt', name: tag };
}

/** How the host answers a remote permission `tag`. Never throws. */
function getRemoteRule(tag: RemotePermission['tag']): ServeRule {
  // The host cannot enforce `Remote` (HTTP/WS) or `WebRtc`, since the sandbox cannot reliably intercept either. A prompt
  // would offer a choice the host could not keep, so both are auto-granted. The browser core serves no balances and no
  // NFT purses, so their permissions are refused, by a rejection rather than a `Deny` the core would store.
  switch (tag) {
    case 'ChainSubmit':
    case 'PreimageSubmit':
    case 'StatementSubmit':
      return { kind: 'prompt', name: tag };
    case 'Remote':
    case 'WebRtc':
      return { kind: 'grant' };
    case 'BalanceAccess':
    case 'NftPurseRead':
      return { kind: 'refuse' };
  }
}

/** True when the host shows `review`, false for an NFT purse drain. Never throws. */
function isServed(review: UserConfirmationReview): review is ServedReview {
  return review.tag !== 'NftPurseDrain';
}
