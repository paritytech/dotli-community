// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Workaround: the signing host in `@parity/truapi-host` 0.24.0 has no permission authorization methods, so the worker
// throws on every read and no product can mount. Until a release adds them, a local wallet core keeps the statuses
// in memory for the page. Delete this file and its call in `local-wallet-core.ts` when dotli moves to that release.

import type { PermissionAuthorizationRequest, PermissionAuthorizationStatus } from '@parity/truapi-host';
import type { WorkerPairingHostRuntime } from '@parity/truapi-host/web';

type PermissionMethods = Pick<
  WorkerPairingHostRuntime,
  'getPermissionAuthorizationStatus' | 'getPermissionAuthorizationStatuses' | 'setPermissionAuthorizationStatus'
>;

/** Answers the runtime's permission authorization calls from page memory instead of the worker. */
export function holdPermissionsInMemory(runtime: PermissionMethods): void {
  const statuses = new Map<string, PermissionAuthorizationStatus>();
  const key = (productId: string, request: PermissionAuthorizationRequest): string =>
    `${productId}\n${JSON.stringify(request)}`;
  const read = (productId: string, request: PermissionAuthorizationRequest): PermissionAuthorizationStatus =>
    statuses.get(key(productId, request)) ?? 'NotDetermined';

  runtime.getPermissionAuthorizationStatus = (productId, request) => Promise.resolve(read(productId, request));
  runtime.getPermissionAuthorizationStatuses = (productId, requests) =>
    Promise.resolve(requests.map(request => read(productId, request)));
  runtime.setPermissionAuthorizationStatus = (productId, request, status) => {
    statuses.set(key(productId, request), status);
    return Promise.resolve();
  };
}
