// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Name and manifest resolution done by the protocol frame's light client.

import type { ResolvePhase } from '@dotli/resolver';
import type { FrameRpc } from './rpc.js';

export function createRemoteResolve(rpc: FrameRpc) {
  return {
    async warmupProtocol(): Promise<void> {
      await rpc.request('warmup', {});
    },
    resolveDotNameRemote: (label: string, onPhase?: (phase: ResolvePhase) => void) =>
      rpc.request('resolveDotName', { label }, onPhase),
    resolveOwnerRemote: (label: string) => rpc.request('resolveOwner', { label }),
    resolveExecutableManifestRemote: (label: string, kind: 'app' | 'widget' | 'worker') =>
      rpc.request('resolveExecutableManifest', { label, kind }),
    resolveRootManifestRemote: (label: string) => rpc.request('resolveRootManifest', { label }),
  };
}
