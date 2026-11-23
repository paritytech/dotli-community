// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Reads names and manifests over the backend the settings chose, so the load never branches on it. The gateway
// resolver is its own chunk, loaded on first use.

import { hasLightClient, type Backend } from '@dotli/config';
import { createReporter } from '@dotli/metrics';
import type { DotnsResolver, ExecutableManifest, ManifestResult, ResolvePhase, RootManifest } from '@dotli/resolver';
import { createAsyncTaskPool, createLazyLoad } from '@dotli/shared';
import type { ProductManifests } from './cachedManifest.js';
import { parseH160Address, type H160Address } from '../../../kit/h160Address.js';
import { productAuthorMetric } from './productAuthorMetric.js';

const resolveReport = createReporter({ flow: 'resolve' });

type PhaseCallback = (phase: ResolvePhase) => void;

type WorkerManifest = Extract<ExecutableManifest, { kind: 'worker' }>;

/** A product's worker as its `worker` subname publishes it: what to run, what it serves and the CID of its files. */
export type WorkerExecutable = Pick<WorkerManifest, 'entrypoint' | 'includes'> & { cid: string };

/** The protocol frame's resolver, which runs on the light client. */
export type RemoteResolver = {
  /** Resolves the name's contenthash, or null when it has none. Rejects with the resolver's error. */
  resolveDotName: (name: string, onPhase?: PhaseCallback) => Promise<string | null>;
  /** Resolves the label's owner address, or null for a name with none. Rejects with the resolver's error. */
  resolveOwner: (label: string) => Promise<string | null>;
  /**
   * Resolves the address's primary name, or null when the address is malformed, stored none, or stored a name it does
   * not own or that breaks the naming rules. Rejects with the resolver's error.
   */
  resolvePrimaryName: (address: string) => Promise<string | null>;
  /** Resolves the label's root manifest. Rejects with the resolver's error. */
  resolveRootManifest: (label: string) => Promise<ManifestResult<RootManifest>>;
  /** Resolves the label's executable manifest of `kind`. Rejects with the resolver's error. */
  resolveExecutableManifest: (label: string, kind: 'app' | 'worker') => Promise<ManifestResult<ExecutableManifest>>;
};

/** The gateway's resolver, which reads over the host's own Asset Hub connection. */
export type RpcResolver = Pick<
  DotnsResolver,
  'resolveDotName' | 'resolveOwner' | 'resolvePrimaryName' | 'resolveRootManifest' | 'resolveExecutableManifest'
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
  const gateway = !hasLightClient(backend);
  // One read of a label's worker at a time, so a read asked meanwhile finds the first one's answer kept.
  const workerReads = createAsyncTaskPool({ poolSize: 1 });
  // This source's worker answers by label. A failed read keeps none, so the next call reads again.
  const workers = new Map<string, WorkerExecutable | null>();

  const resolveName = async (name: string, { onPhase }: ResolveProductParams = {}): Promise<string | null> =>
    gateway ? (await rpcResolver()).resolveDotName(name, { onPhase }) : remote.resolveDotName(name, onPhase);

  async function resolveProduct(label: string, { onPhase }: ResolveProductParams = {}): Promise<string | null> {
    const cid = await resolveName(`app.${label}`, { onPhase });
    if (cid !== null) {
      return cid;
    }
    resolveReport.log.event('App subname has no contenthash, trying the base name');
    return resolveName(label, { onPhase });
  }

  async function readManifests(label: string): Promise<ProductManifests> {
    const [{ root, app }, owner] = await Promise.all([readRootAndAppManifests(label), readOwnerIfKnown(label)]);
    return owner === undefined ? { root, app } : { root, app, owner };
  }

  /** The resolver of dotNS records, which both backends read alike. Only the name's lookup differs. */
  async function getRecordResolver(): Promise<
    Pick<RemoteResolver, 'resolveOwner' | 'resolvePrimaryName' | 'resolveRootManifest' | 'resolveExecutableManifest'>
  > {
    return gateway ? rpcResolver() : remote;
  }

  async function readRootAndAppManifests(label: string): Promise<Pick<ProductManifests, 'root' | 'app'>> {
    const resolver = await getRecordResolver();
    const [root, app] = await Promise.all([
      resolver.resolveRootManifest(label),
      resolver.resolveExecutableManifest(label, 'app'),
    ]);
    return { root, app };
  }

  async function readPrimaryName(address: H160Address): Promise<string | null> {
    return (await getRecordResolver()).resolvePrimaryName(address);
  }

  function readWorkerExecutable(label: string): Promise<WorkerExecutable | null> {
    return workerReads.call(() => readWorkerExecutableOnce(label), { pool: label });
  }

  async function readWorkerExecutableOnce(label: string): Promise<WorkerExecutable | null> {
    const kept = workers.get(label);
    if (kept !== undefined) {
      return kept;
    }
    const [manifest, cid] = await Promise.all([readWorkerManifest(label), resolveName(`worker.${label}`)]);
    const executable = toWorkerExecutable(manifest, cid);
    workers.set(label, executable);
    return executable;
  }

  async function readWorkerManifest(label: string): Promise<ManifestResult<ExecutableManifest>> {
    return (await getRecordResolver()).resolveExecutableManifest(label, 'worker');
  }

  /**
   * Resolves undefined when the owner read fails or answers with something that is not a 20-byte hex address, which
   * goes to `report`, since the author never fails the load.
   */
  async function readOwnerIfKnown(label: string): Promise<H160Address | null | undefined> {
    try {
      const owner = await (await getRecordResolver()).resolveOwner(label);
      return owner === null ? null : parseH160Address(owner);
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
    /**
     * Resolves the product's worker executable once per label for this source's life: its worker manifest's entrypoint
     * and includes, with the CID of its `worker` subname. Resolves null when the product publishes no worker manifest,
     * an invalid one or no contenthash for it. A call made while a read of the label runs gets that read's answer.
     * Rejects with the resolver's or the gateway load's error, and a failed read is not kept, so the next call reads
     * again.
     */
    readWorkerExecutable,
    /**
     * Resolves the address's dotNS primary name, or null when it stored none or does not own the name it stored.
     * Rejects with the resolver's or the gateway load's error.
     */
    readPrimaryName,
  };
}

/** A worker manifest and its subname's CID, as the worker they make, or null when they make none. */
function toWorkerExecutable(manifest: ManifestResult<ExecutableManifest>, cid: string | null): WorkerExecutable | null {
  if (manifest.kind !== 'ok' || manifest.value.kind !== 'worker') {
    resolveReport.log.event('Product has no usable worker manifest, so no worker', { manifest: manifest.kind });
    return null;
  }
  if (cid === null) {
    resolveReport.log.event('Worker subname has no contenthash, so no worker');
    return null;
  }
  const { entrypoint, includes } = manifest.value;
  return { entrypoint, includes, cid };
}

function reportOwnerRead(error: unknown): void {
  resolveReport.expected(error, { step: 'product_author_owner', metric: productAuthorMetric, reason: 'owner' });
}
