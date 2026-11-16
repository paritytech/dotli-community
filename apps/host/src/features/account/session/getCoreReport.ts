// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The state the page shows for what its core reported.

import type { AuthState as CoreAuthState, SessionUiInfo } from '@parity/truapi-host';
import type { TruapiSessionUiState } from './parseUiStateCache.js';
import type { DotliAuthState } from './types.js';

/** How pairing presents itself. */
export type PairingPresentation = {
  /** The name pairing presents. */
  label: string;
  /** Whether the label takes the active top-level domain. */
  dotSuffix?: boolean | undefined;
  /** Whether the pairing is for dotli itself rather than one product. */
  hostGlobal?: boolean | undefined;
};

/** The state the page shows for what the core reported. */
export function getCoreReport(core: CoreAuthState, pairing: PairingPresentation): DotliAuthState {
  switch (core.tag) {
    case 'Pairing':
      return {
        tag: 'Pairing',
        deeplink: core.value.deeplink,
        label: pairing.label,
        dotSuffix: pairing.dotSuffix,
        hostGlobal: pairing.hostGlobal,
      };
    case 'Authenticating':
      return { tag: 'Authenticating' };
    case 'Connected':
      return { tag: 'Connected', session: getSessionUiState(core.value) };
    case 'Disconnected':
      return { tag: 'Disconnected' };
    case 'LoginFailed':
      return { tag: 'LoginFailed', kind: core.value.kind, reason: core.value.reason };
  }
}

function getSessionUiState(info: SessionUiInfo): TruapiSessionUiState {
  const primaryUsername = info.fullUsername ?? info.liteUsername;
  return {
    connected: true,
    publicKey: info.publicKey,
    ...(info.identityAccountId !== undefined ? { identityAccountId: info.identityAccountId } : {}),
    ...(info.liteUsername !== undefined ? { liteUsername: info.liteUsername } : {}),
    ...(info.fullUsername !== undefined ? { fullUsername: info.fullUsername } : {}),
    ...(primaryUsername !== undefined ? { primaryUsername } : {}),
  };
}
