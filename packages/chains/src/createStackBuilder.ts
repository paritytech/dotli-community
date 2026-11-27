// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The engine checks each light spec against the SHA-256 its descriptor names, so a spec kept from an earlier start is
// as good as a fetched one, and a refused spec means the copy the start opened went stale. The descriptor's operator
// re-publishes it whenever a spec changes, so a refused start runs again once from the newer copy.

import { createReporter, defineCount } from '@dotli/metrics';
import { createAsyncTaskPool, getErrorMessage, realTimers, type Timers } from '@dotli/shared';
import type { ChainProviderBuilder, LightSpecSource } from '@parity/truapi-provider';

const report = createReporter({ flow: 'protocol' });

/**
 * The light specs of a newer stack copy that could not be stored for the next start. Counted only on failure, tagged
 * `outcome` (error) and `reason` (the error's name).
 */
const lightSpecRefreshMetric = defineCount<'error'>('light_spec.refresh');

/** A network's signed Trinity stack, which the light client runs the chains of. */
export type LightClientStack = {
  /** The stack's link, which carries the key the descriptor is signed with. */
  pointer: string;
  /** The signed descriptor's bytes, as served. */
  descriptor: Uint8Array;
};

/** Light spec bytes as served, by their `0x` SHA-256. */
export type LightSpecs = ReadonlyMap<string, Uint8Array>;

/** The network's light specs, kept from an earlier start. */
export type LightSpecStore = {
  /** The kept set, empty when there is none. */
  held: LightSpecs;
  /** Replaces the kept set, so a spec left out is dropped, and resolves whether the write committed. */
  set: (specs: LightSpecs) => Promise<boolean>;
};

/** A copy newer than the one a start opened, not stored for the next start until it is kept. */
export type NewerLightClientStack = LightClientStack & {
  /** Stores this copy for the next start. */
  keep: () => Promise<void>;
};

/** The copy a start opens. A fetched copy carries the `keep` that stores it, and a stored or bundled one `null`. */
export type StartingLightClientStack = LightClientStack & { keep: NewerLightClientStack['keep'] | null };

/** What a light client's start reads of its network's stack. */
export type LightClientStackSource = {
  stack: StartingLightClientStack;
  /** A copy newer than `stack`, which the engine has yet to check, or `null` when none arrived. */
  newer: Promise<NewerLightClientStack | null>;
  lightSpecs: LightSpecStore;
};

/** What a stack's start uses of truapi-provider's builder. */
export type StackBuilder = Pick<ChainProviderBuilder, 'setStack' | 'addLightSpec' | 'free'> & {
  lightSpecs(): readonly SpecSource[];
};

type SpecSource = Pick<LightSpecSource, 'genesisHash' | 'role' | 'url' | 'sha256'>;

type Params<Builder extends StackBuilder> = {
  source: LightClientStackSource;
  /** A fresh builder, since one that took a stack takes no other. */
  createBuilder: () => Builder;
  fetch?: typeof fetch;
  /** The retry waits run on them. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
};

/** A builder that took a copy and every spec it names, with those specs. */
type OpenedStack<Builder> = {
  builder: Builder;
  specs: LightSpecs;
};

const FETCH_RETRY_COUNT = 3;
const FETCH_RETRY_BASE_MS = 500;

/**
 * Resolves with a builder that holds the source's stack and every light spec its descriptor names, ready to build.
 * Each spec comes from the kept set by its SHA-256, else from the network, retried. The accepted set is kept for the
 * next start. A spec the engine refuses starts it again from the newer copy. When the newer copy arrives after a start
 * from an older one, its specs are checked on a builder freed afterwards and kept for the next start, which never
 * affects the builder this resolves with. A copy that is not stored yet, the one started from or a newer one, is kept
 * only once the engine took it and the store holds its specs.
 * Rejects when the engine refuses a descriptor or a spec, when a spec is refused and no newer copy arrives, or when a
 * fetch still fails after its retries, with the failure as `cause`.
 */
export async function createStackBuilder<Builder extends StackBuilder>({
  source: { stack, newer, lightSpecs },
  createBuilder,
  fetch: fetchResource = fetch,
  timers = realTimers,
}: Params<Builder>): Promise<Builder> {
  // Unbounded, since every spec is fetched at once. The pool only retries.
  const pool = createAsyncTaskPool({
    poolSize: Number.POSITIVE_INFINITY,
    retryCount: FETCH_RETRY_COUNT,
    retryDelay: retry => FETCH_RETRY_BASE_MS * 2 ** retry,
    timers,
  });
  const { held } = lightSpecs;

  function getSpec(source: SpecSource, known: LightSpecs): Promise<Uint8Array> {
    const kept = known.get(source.sha256);
    if (kept !== undefined) {
      return Promise.resolve(kept);
    }
    return pool
      .call(() => readBytes(fetchResource, source.url))
      .catch((error: unknown) => {
        throw new Error(`${describeSpec(source)} could not be fetched: ${getErrorMessage(error)}`, { cause: error });
      });
  }

  /** Opens `copy` on a fresh builder with every spec it names. Frees the builder and rejects when that fails. */
  async function openStack(copy: LightClientStack, known: LightSpecs, label: string): Promise<OpenedStack<Builder>> {
    const builder = createBuilder();
    try {
      try {
        builder.setStack(copy.pointer, copy.descriptor);
      } catch (error) {
        throw new Error(
          `The light client refused the ${label} descriptor of stack ${copy.pointer}: ${getErrorMessage(error)}`,
          { cause: error },
        );
      }
      const specs = await Promise.all(
        builder.lightSpecs().map(source => getSpec(source, known).then(bytes => ({ source, bytes }))),
      );
      for (const { source, bytes } of specs) {
        try {
          builder.addLightSpec(source.genesisHash, bytes);
        } catch (error) {
          throw new SpecRefusedError(`${describeSpec(source)} was refused: ${getErrorMessage(error)}`, {
            cause: error,
          });
        }
      }
      return { builder, specs: new Map(specs.map(({ source, bytes }) => [source.sha256, bytes])) };
    } catch (error) {
      builder.free();
      throw error;
    }
  }

  /** Keeps `specs` unless they are the set `stored` already holds, and resolves whether the store holds them. */
  function keepSpecs(specs: LightSpecs, stored: LightSpecs): Promise<boolean> {
    if (specs.size === stored.size && [...specs.keys()].every(sha256 => stored.has(sha256))) {
      return Promise.resolve(true);
    }
    return lightSpecs.set(specs);
  }

  /**
   * Checks the newer copy's specs on a builder of its own, with the spec bytes in `known`, then keeps them and, once
   * the store holds them, the copy. `stored` is the set the store holds. Reports a failure.
   */
  async function refreshSpecs(copy: NewerLightClientStack, known: LightSpecs, stored: LightSpecs): Promise<void> {
    try {
      const { builder, specs } = await openStack(copy, known, 'newer');
      builder.free();
      if (await keepSpecs(specs, stored)) {
        await copy.keep();
      }
    } catch (error) {
      report.expected(error, {
        step: 'light_spec_refresh',
        metric: lightSpecRefreshMetric,
        message: `[dot.li provider] the light specs of a newer copy of stack ${copy.pointer} were not kept: ${getErrorMessage(error)}`,
      });
    }
  }

  let opened: OpenedStack<Builder>;
  try {
    opened = await openStack(stack, held, 'starting');
  } catch (error) {
    if (!(error instanceof SpecRefusedError)) {
      throw error;
    }
    report.log.event('Newer stack descriptor awaited', { stack: stack.pointer, reason: error.message });
    const live = await newer;
    if (live === null) {
      throw new Error(`No copy of stack ${stack.pointer} newer than the refused one could be had`, { cause: error });
    }
    const fresh = await openStack(live, held, 'newer');
    void keepSpecs(fresh.specs, held).then(isStored => (isStored ? live.keep() : undefined));
    return fresh.builder;
  }
  const { specs } = opened;
  // After the keep, so the newer set replaces this one.
  void keepSpecs(specs, held).then(async isStored => {
    if (isStored) {
      await stack.keep?.();
    }
    const copy = await newer;
    if (copy !== null) {
      // A failed write keeps the set the start read.
      await refreshSpecs(copy, specs, isStored ? specs : held);
    }
  });
  return opened.builder;
}

/** A spec the engine refused, which a stale descriptor explains. */
class SpecRefusedError extends Error {
  override readonly name = 'SpecRefusedError';
}

/**
 * The response body at `url`, fetched past any cached copy. Rejects when the fetch fails or answers other than ok.
 */
async function readBytes(fetchResource: typeof fetch, url: string): Promise<Uint8Array> {
  // A copy the HTTP cache kept could predate the descriptor it is checked against.
  const response = await fetchResource(url, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`GET ${url} answered ${String(response.status)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function describeSpec({ role, genesisHash, url }: SpecSource): string {
  return `The light spec of ${role} (${genesisHash}) from ${url}`;
}
