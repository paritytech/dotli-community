// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reads names and manifests over the backend the settings chose, so the load never branches on it. The gateway
// resolver is its own chunk, loaded on first use.

import type { Backend } from '@dotli/config';
import type { DotnsResolver, ExecutableManifest, ManifestResult, ResolvePhase, RootManifest } from '@dotli/resolver';
import { createLazyLoad, log } from '@dotli/shared';
import type { ProductManifests } from './cachedManifest.js';

type PhaseCallback = (phase: ResolvePhase) => void;

/** The protocol frame's resolver, which runs on the light client. */
export type RemoteResolver = {
  /** Resolves the name's contenthash, or null when it has none. Rejects with the resolver's error. */
  resolveDotName: (name: string, onPhase?: PhaseCallback) => Promise<string | null>;
  /** Resolves the label's root manifest. Rejects with the resolver's error. */
  resolveRootManifest: (label: string) => Promise<ManifestResult<RootManifest>>;
  /** Resolves the label's executable manifest of `kind`. Rejects with the resolver's error. */
  resolveExecutableManifest: (label: string, kind: 'app' | 'worker') => Promise<ManifestResult<ExecutableManifest>>;
};

/** The gateway's resolver, which reads over the host's own Asset Hub connection. */
export type RpcResolver = Pick<DotnsResolver, 'resolveDotName' | 'resolveRootManifest' | 'resolveExecutableManifest'>;

type Params = {
  backend: Backend;
  remote: RemoteResolver;
  /** Loads the gateway resolver ready to use. A rejected load is tried again by the next read. */
  loadRpc: () => Promise<RpcResolver>;
};

type ResolveProductParams = {
  /** Hears each phase of the lookup. */
  onPhase?: PhaseCallback | undefined;
};

export type NameSource = ReturnType<typeof createNameSource>;

/** Builds the name source over `backend`. Its reads reject with the resolver's or the gateway load's error. */
export function createNameSource({ backend, remote, loadRpc }: Params) {
  const rpcResolver = createLazyLoad({ load: loadRpc });
  const gateway = backend === 'rpc-gateway';

  const resolveName = async (name: string, { onPhase }: ResolveProductParams = {}): Promise<string | null> =>
    gateway ? (await rpcResolver()).resolveDotName(name, { onPhase }) : remote.resolveDotName(name, onPhase);

  async function resolveProduct(label: string, { onPhase }: ResolveProductParams = {}): Promise<string | null> {
    const cid = await resolveName(`app.${label}`, { onPhase });
    if (cid !== null) {
      return cid;
    }
    log.event('App subname has no contenthash, trying the base name', { flow: 'resolve' });
    return resolveName(label, { onPhase });
  }

  async function readManifests(label: string): Promise<ProductManifests> {
    if (gateway) {
      const resolver = await rpcResolver();
      const [root, app] = await Promise.all([
        resolver.resolveRootManifest(label),
        resolver.resolveExecutableManifest(label, 'app'),
      ]);
      return { root, app };
    }
    const [root, app] = await Promise.all([
      remote.resolveRootManifest(label),
      remote.resolveExecutableManifest(label, 'app'),
    ]);
    return { root, app };
  }

  async function readWorkerManifest(label: string): Promise<ManifestResult<ExecutableManifest>> {
    return gateway
      ? (await rpcResolver()).resolveExecutableManifest(label, 'worker')
      : remote.resolveExecutableManifest(label, 'worker');
  }

  return {
    /**
     * Resolves the product's contenthash: its app subname's, else the base name's, or null when neither has one.
     * Rejects with the resolver's or the gateway load's error.
     */
    resolveProduct,
    /** Resolves the product's root and app manifests. Rejects with the resolver's or the gateway load's error. */
    readManifests,
    /** Resolves the product's worker manifest. Rejects with the resolver's or the gateway load's error. */
    readWorkerManifest,
  };
}
