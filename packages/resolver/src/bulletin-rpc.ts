// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Trusted-RPC Bulletin Paseo preimage submission.
//
// This is the rpc-gateway counterpart to `./bulletin`: it submits
// TransactionStorage.store through configured WSS JSON-RPC endpoints and
// intentionally does not import smoldot.

import { createClient, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { getPolkadotSigner } from "@polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
  DEV_PHRASE,
  entropyToMiniSecret,
  mnemonicToEntropy,
} from "@polkadot-labs/hdkd-helpers";
import { getActiveServicesConfig } from "@dotli/config/network";
import { log } from "@dotli/shared/log";

let bulletinRpcClient: PolkadotClient | null = null;
let bulletinRpcClientPromise: Promise<PolkadotClient> | null = null;

export async function ensureBulletinRpcClient(): Promise<PolkadotClient> {
  if (bulletinRpcClient !== null) {
    return bulletinRpcClient;
  }
  bulletinRpcClientPromise ??= (async () => {
    const rpcs = getActiveServicesConfig().bulletin.rpcs;
    if (rpcs.length === 0) {
      throw new Error("No Bulletin RPC endpoints configured for this network");
    }
    const provider = getWsProvider([...rpcs], {
      heartbeatTimeout: 120_000,
    });
    const candidate = createClient(provider);
    try {
      await candidate.getFinalizedBlock();
    } catch (err) {
      try {
        candidate.destroy();
        // eslint-disable-next-line no-restricted-syntax -- best-effort teardown; the original RPC sync error is rethrown below.
      } catch {
        /* already dead */
      }
      bulletinRpcClient = null;
      bulletinRpcClientPromise = null;
      throw err;
    }
    bulletinRpcClient = candidate;
    log.warn("[dot.li bulletin-rpc] Client synced to finalized block");
    return bulletinRpcClient;
  })().catch((err: unknown) => {
    bulletinRpcClientPromise = null;
    throw err;
  });
  return bulletinRpcClientPromise;
}

export function getTestSigner(): ReturnType<typeof getPolkadotSigner> {
  const entropy = mnemonicToEntropy(DEV_PHRASE);
  const miniSecret = entropyToMiniSecret(entropy);
  const derive = sr25519CreateDerive(miniSecret);
  const alice = derive("//Alice");

  return getPolkadotSigner(alice.publicKey, "Sr25519", (input: Uint8Array) =>
    alice.sign(input),
  );
}

const TX_TIMEOUT_MS = 120_000;

export async function submitPreimageTransactionViaRpc(
  data: Uint8Array,
  signer: ReturnType<typeof getPolkadotSigner>,
): Promise<void> {
  const client = await ensureBulletinRpcClient();
  const api = client.getUnsafeApi();
  const tx = api.tx.TransactionStorage.store({ data });

  await new Promise<void>((resolve, reject) => {
    let resolved = false;

    const subscription = tx.signSubmitAndWatch(signer).subscribe({
      next: (ev: {
        type: string;
        found?: boolean;
        ok?: boolean;
        dispatchError?: { type: string; value: unknown };
      }) => {
        log.debug(`[dot.li bulletin-rpc] tx event`, { type: ev.type });
        if (resolved || ev.type !== "txBestBlocksState" || ev.found !== true) {
          return;
        }
        resolved = true;
        clearTimeout(timeoutId);
        subscription.unsubscribe();
        if (ev.ok === false) {
          reject(
            new Error(
              `TransactionStorage.store dispatch failed: ${ev.dispatchError?.type ?? "Unknown"}`,
              { cause: ev.dispatchError },
            ),
          );
          return;
        }
        resolve();
      },
      error: (e: unknown) => {
        if (resolved) {
          return;
        }
        resolved = true;
        clearTimeout(timeoutId);
        subscription.unsubscribe();
        reject(new Error("Bulletin RPC tx failed", { cause: e }));
      },
    });

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        subscription.unsubscribe();
        reject(new Error("Transaction timed out"));
      }
    }, TX_TIMEOUT_MS);
  });
}
