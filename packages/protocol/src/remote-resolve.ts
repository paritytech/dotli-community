// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Name and manifest resolution done by the protocol frame's light client.

import type { ExecutableManifest, ManifestResult, ResolvePhase, RootManifest } from '@dotli/resolver';
import type { FrameRpc } from './rpc.js';

export interface RemoteResolve {
  warmupProtocol(): Promise<void>;
  resolveDotNameRemote(label: string, onPhase?: (phase: ResolvePhase) => void): Promise<string | null>;
  resolveOwnerRemote(label: string): Promise<string | null>;
  resolveExecutableManifestRemote(
    label: string,
    kind: 'app' | 'widget' | 'worker',
  ): Promise<ManifestResult<ExecutableManifest>>;
  resolveRootManifestRemote(label: string): Promise<ManifestResult<RootManifest>>;
}

export function createRemoteResolve(rpc: FrameRpc): RemoteResolve {
  return {
    async warmupProtocol() {
      await rpc.request('warmup', {});
    },
    async resolveDotNameRemote(label, onPhase) {
      return (await rpc.request('resolveDotName', { label }, onPhase)) as string | null;
    },
    async resolveOwnerRemote(label) {
      return (await rpc.request('resolveOwner', { label })) as string | null;
    },
    async resolveExecutableManifestRemote(label, kind) {
      return (await rpc.request('resolveExecutableManifest', { label, kind })) as ManifestResult<ExecutableManifest>;
    },
    async resolveRootManifestRemote(label) {
      return (await rpc.request('resolveRootManifest', { label })) as ManifestResult<RootManifest>;
    },
  };
}
