// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reads names and manifests over the backend the settings chose, so the load never branches on it. The gateway
// resolver is its own chunk, loaded on first use.

import type { Backend } from '@dotli/config';
import type { DotnsResolver, ExecutableManifest, ManifestResult, ResolvePhase, RootManifest } from '@dotli/resolver';
import { createLazyLoad, log } from '@dotli/shared';
import type { ProductManifests } from './manifest-gate.js';

type PhaseCallback = (phase: ResolvePhase) => void;

/** The protocol frame's resolver, which runs on the light client. */
export type RemoteResolver = {
  resolveDotName: (name: string, onPhase?: PhaseCallback) => Promise<string | null>;
  resolveRootManifest: (label: string) => Promise<ManifestResult<RootManifest>>;
  resolveExecutableManifest: (label: string, kind: 'app' | 'worker') => Promise<ManifestResult<ExecutableManifest>>;
};

/** The gateway's resolver, which reads over the host's own Asset Hub connection. */
export type RpcResolver = Pick<DotnsResolver, 'resolveDotName' | 'resolveRootManifest' | 'resolveExecutableManifest'>;

export type NameSourceDeps = {
  backend: Backend;
  remote: RemoteResolver;
  /** Loads the gateway resolver ready to use. A rejected load is tried again by the next read. */
  loadRpc: () => Promise<RpcResolver>;
};

export type NameSource = {
  /** The product's contenthash: its app subname's, else the base name's. */
  resolveProduct: (label: string, onPhase?: PhaseCallback) => Promise<string | null>;
  readManifests: (label: string) => Promise<ProductManifests>;
  readWorkerManifest: (label: string) => Promise<ManifestResult<ExecutableManifest>>;
};

export function createNameSource(deps: NameSourceDeps): NameSource {
  const rpcResolver = createLazyLoad(deps.loadRpc);
  const gateway = deps.backend === 'rpc-gateway';

  const resolveName = async (name: string, onPhase?: PhaseCallback): Promise<string | null> =>
    gateway ? (await rpcResolver()).resolveDotName(name, { onPhase }) : deps.remote.resolveDotName(name, onPhase);

  return {
    resolveProduct: async (label, onPhase) => {
      const cid = await resolveName(`app.${label}`, onPhase);
      if (cid !== null) {
        return cid;
      }
      log.event('App subname has no contenthash, trying the base name', { flow: 'resolve' });
      return resolveName(label, onPhase);
    },
    readManifests: async label => {
      if (gateway) {
        const mod = await rpcResolver();
        const [root, app] = await Promise.all([
          mod.resolveRootManifest(label),
          mod.resolveExecutableManifest(label, 'app'),
        ]);
        return { root, app };
      }
      const [root, app] = await Promise.all([
        deps.remote.resolveRootManifest(label),
        deps.remote.resolveExecutableManifest(label, 'app'),
      ]);
      return { root, app };
    },
    readWorkerManifest: async label =>
      gateway
        ? (await rpcResolver()).resolveExecutableManifest(label, 'worker')
        : deps.remote.resolveExecutableManifest(label, 'worker'),
  };
}
