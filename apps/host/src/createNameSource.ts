// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reads names and manifests over the backend the settings chose, so the load never branches on it. The gateway
// resolver is its own chunk, loaded on first use.

import type { Backend } from '@dotli/config';
import { reportExpected, spans as S } from '@dotli/metrics';
import type { DotnsResolver, ExecutableManifest, ManifestResult, ResolvePhase, RootManifest } from '@dotli/resolver';
import { createLazyLoad, log } from '@dotli/shared';
import type { ProductManifests } from './cachedManifest.js';
import { parseH160Address, type H160Address } from './h160Address.js';

type PhaseCallback = (phase: ResolvePhase) => void;

/** The protocol frame's resolver, which runs on the light client. */
export type RemoteResolver = {
  /** Resolves the name's contenthash, or null when it has none. Rejects with the resolver's error. */
  resolveDotName: (name: string, onPhase?: PhaseCallback) => Promise<string | null>;
  /** Resolves the label's owner address, or null for a name with none. Rejects with the resolver's error. */
  resolveOwner: (label: string) => Promise<string | null>;
  /** Resolves the label's root manifest. Rejects with the resolver's error. */
  resolveRootManifest: (label: string) => Promise<ManifestResult<RootManifest>>;
  /** Resolves the label's executable manifest of `kind`. Rejects with the resolver's error. */
  resolveExecutableManifest: (label: string, kind: 'app' | 'worker') => Promise<ManifestResult<ExecutableManifest>>;
};

/** The gateway's resolver, which reads over the host's own Asset Hub connection. */
export type RpcResolver = Pick<
  DotnsResolver,
  'resolveDotName' | 'resolveOwner' | 'resolveRootManifest' | 'resolveExecutableManifest'
>;

type Params = {
  backend: Backend;
  remote: RemoteResolver;
  /** Loads the gateway resolver ready to use. A rejected load is tried again by the next read. */
  loadRpc: () => Promise<RpcResolver>;
  /** Hears an owner read that failed while the manifests were read. */
  report?: (error: unknown) => void;
};

type ResolveProductParams = {
  /** Hears each phase of the lookup. */
  onPhase?: PhaseCallback | undefined;
};

export type NameSource = ReturnType<typeof createNameSource>;

/** Builds the name source over `backend`. Its reads reject with the resolver's or the gateway load's error. */
export function createNameSource({ backend, remote, loadRpc, report = reportOwnerRead }: Params) {
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
    const [{ root, app }, owner] = await Promise.all([readRootAndAppManifests(label), readOwnerIfKnown(label)]);
    return owner === undefined ? { root, app } : { root, app, owner };
  }

  async function readRootAndAppManifests(label: string): Promise<Pick<ProductManifests, 'root' | 'app'>> {
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

  async function resolveOwner(label: string): Promise<H160Address | null> {
    const owner = gateway ? await (await rpcResolver()).resolveOwner(label) : await remote.resolveOwner(label);
    return owner === null ? null : parseH160Address(owner);
  }

  /** Resolves undefined when the owner read fails, which goes to `report`, since the author never fails the load. */
  async function readOwnerIfKnown(label: string): Promise<H160Address | null | undefined> {
    try {
      return await resolveOwner(label);
    } catch (error) {
      report(error);
      return undefined;
    }
  }

  return {
    /**
     * Resolves the product's contenthash: its app subname's, else the base name's, or null when neither has one.
     * Rejects with the resolver's or the gateway load's error.
     */
    resolveProduct,
    /**
     * Resolves the product's root and app manifests, with its dotNS owner when that read works. An owner read that
     * fails, or answers with no 20-byte hex address, leaves the owner out and goes to `report`. Rejects with the
     * resolver's or the gateway load's error.
     */
    readManifests,
    /** Resolves the product's worker manifest. Rejects with the resolver's or the gateway load's error. */
    readWorkerManifest,
  };
}

function reportOwnerRead(error: unknown): void {
  reportExpected(error, { flow: 'resolve', step: 'product_author_owner', metric: S.PRODUCT_AUTHOR, reason: 'owner' });
}
