// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The engine checks each light spec against the digest its descriptor names. The descriptor's operator re-publishes it
// whenever a spec changes, so a refused spec means the build copy went stale, and the start runs again once from the
// live copy the stack's link points at. The engine checks the live copy's signature against the key in the same link.

import { createReporter } from '@dotli/metrics';
import { createAsyncTaskPool, getErrorMessage, realTimers, type Timers } from '@dotli/shared';
import type { ChainProviderBuilder, LightSpecSource } from '@parity/truapi-provider';

const report = createReporter({ flow: 'protocol' });

/** A network's signed Trinity stack, which the light client runs the chains of. */
export type LightClientStack = {
  /** The stack's link, which carries the key the descriptor is signed with and the URL the live copy is served at. */
  pointer: string;
  /** The signed descriptor's bytes, as served. */
  descriptor: Uint8Array;
};

/** What a stack's start uses of truapi-provider's builder. */
export type StackBuilder = Pick<ChainProviderBuilder, 'setStack' | 'addLightSpec'> & {
  lightSpecs(): readonly SpecSource[];
};

type SpecSource = Pick<LightSpecSource, 'genesisHash' | 'role' | 'url'>;

type Params<Builder extends StackBuilder> = {
  stack: LightClientStack;
  /** A fresh builder, since one that took a stack takes no other. */
  createBuilder: () => Builder;
  fetch?: typeof fetch;
  /** The retry waits run on them. */
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
};

const FETCH_RETRY_COUNT = 3;
const FETCH_RETRY_BASE_MS = 500;

/**
 * Resolves with a builder that holds `stack` and every light spec its descriptor names, ready to build. A spec the
 * engine refuses against the build copy starts it again from the live descriptor, fetched once. Each fetch is retried.
 * Rejects when the engine refuses the stack, the live descriptor or one of its specs, or when a fetch still fails after
 * its retries, with the failure as `cause`.
 */
export async function createStackBuilder<Builder extends StackBuilder>({
  stack: { pointer, descriptor },
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

  function fetchBytes(url: string): Promise<Uint8Array> {
    return pool.call(() => readBytes(fetchResource, url));
  }

  async function openStack(signed: Uint8Array, copy: string): Promise<Builder> {
    const builder = createBuilder();
    try {
      builder.setStack(pointer, signed);
    } catch (error) {
      throw new Error(
        `The light client refused the ${copy} descriptor of stack ${pointer}: ${getErrorMessage(error)}`,
        {
          cause: error,
        },
      );
    }
    const specs = await Promise.all(
      builder.lightSpecs().map(source =>
        fetchBytes(source.url).then(
          bytes => ({ source, bytes }),
          (error: unknown) => {
            throw new Error(`${describeSpec(source)} could not be fetched: ${getErrorMessage(error)}`, {
              cause: error,
            });
          },
        ),
      ),
    );
    for (const { source, bytes } of specs) {
      try {
        builder.addLightSpec(source.genesisHash, bytes);
      } catch (error) {
        throw new SpecRefusedError(`${describeSpec(source)} was refused: ${getErrorMessage(error)}`, { cause: error });
      }
    }
    return builder;
  }

  try {
    return await openStack(descriptor, 'bundled');
  } catch (error) {
    if (!(error instanceof SpecRefusedError)) {
      throw error;
    }
    report.log.event('Stack descriptor refetched', { stack: pointer, reason: error.message });
  }
  const url = getDescriptorUrl(pointer);
  let live: Uint8Array;
  try {
    live = await fetchBytes(url);
  } catch (error) {
    throw new Error(`The live descriptor of stack ${pointer} could not be fetched: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }
  return openStack(live, 'live');
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

/** The URL the live descriptor is served at, from the stack's link. Throws when the link names none. */
function getDescriptorUrl(pointer: string): string {
  const url = new URL(pointer).searchParams.get('url');
  if (url === null) {
    throw new Error(`Stack link ${pointer} names no descriptor URL`);
  }
  return url;
}
