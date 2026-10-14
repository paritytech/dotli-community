// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One runtime API call at the newest finalized block, over a chainHead follow (with the runtime) that closes after
// the call. The cache-node settings read the provider registry on Asset Hub with it (ReviveApi_call).

import type { JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { createClient, OperationInaccessibleError } from '@polkadot-api/substrate-client';
import { fromHex } from '@polkadot-api/utils';

// A light client answers `operationInaccessible` just after it syncs, before a peer served the proof.
const INACCESSIBLE_RETRY_DELAY_MS = 750;

export interface RuntimeCallResult {
  /** The SCALE output of the call, as hex. */
  output: string;
  /** The finalized block of the call. */
  block: { hash: string; number: number };
}

// The block number of a SCALE header: a compact integer after the 32-byte parent hash.
function headerNumber(header: string): number {
  const bytes = fromHex(header).subarray(32);
  const first = bytes[0] ?? 0;
  switch (first & 3) {
    case 0:
      return first >> 2;
    case 1:
      return ((bytes[1] ?? 0) << 6) | (first >> 2);
    case 2:
      return (bytes[3] ?? 0) * 2 ** 22 + ((bytes[2] ?? 0) << 14) + ((bytes[1] ?? 0) << 6) + (first >> 2);
    default:
      throw new Error('a block number of more than 30 bits');
  }
}

/** Call the runtime API `method` with the SCALE `args` (hex) at the newest finalized block of the chain of `provider`. */
export function finalizedRuntimeCall(
  provider: JsonRpcProvider,
  method: string,
  args: string,
  timeoutMs = 30_000,
): Promise<RuntimeCallResult> {
  const client = createClient(provider);
  return new Promise<RuntimeCallResult>((resolve, reject) => {
    let done = false;
    const finish = (settle: () => void): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      try {
        follow.unfollow();
        // eslint-disable-next-line no-restricted-syntax -- the follow stopped already, and the call has its result.
      } catch {
        /* ignore */
      }
      client.destroy();
      settle();
    };
    const timer = setTimeout(() => {
      finish(() => {
        reject(new Error(`${method}: no answer in ${String(timeoutMs)} ms`));
      });
    }, timeoutMs);
    const call = async (hash: string): Promise<RuntimeCallResult> => {
      for (;;) {
        try {
          const [output, header] = await Promise.all([follow.call(hash, method, args), follow.header(hash)]);
          return { output, block: { hash, number: headerNumber(header) } };
        } catch (err) {
          if (!(err instanceof OperationInaccessibleError) || done) {
            throw err;
          }
        }
        await new Promise(wait => setTimeout(wait, INACCESSIBLE_RETRY_DELAY_MS));
      }
    };
    // A runtime call needs a follow with the runtime.
    const follow = client.chainHead(
      true,
      event => {
        if (event.type !== 'initialized') {
          return;
        }
        const hash = event.finalizedBlockHashes.at(-1);
        if (hash === undefined) {
          finish(() => {
            reject(new Error('the chain gave no finalized block'));
          });
          return;
        }
        call(hash).then(
          result => {
            finish(() => {
              resolve(result);
            });
          },
          (err: unknown) => {
            finish(() => {
              reject(err instanceof Error ? err : new Error(String(err)));
            });
          },
        );
      },
      err => {
        finish(() => {
          reject(err);
        });
      },
    );
  });
}
