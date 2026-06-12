// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Host-side Bulletin preimage submission, signed by the user's allowance
 * slot account.
 *
 * Provider selection mirrors initAuth's People chain wiring in @dotli/auth.
 * Smoldot backends bridge to the protocol iframe / shared worker's
 * ChainBroker by genesis hash, while `rpc-gateway` dials the configured WS
 * endpoints directly.
 */

import {
  createClient,
  type PolkadotClient,
  type PolkadotSigner,
} from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { createRemoteChainProvider } from "@dotli/protocol/client";
import { getActiveServicesConfig } from "@dotli/config/network";
import { getBackend } from "@dotli/config/mode";
import { log } from "@dotli/shared/log";

let bulletinClient: PolkadotClient | null = null;

function ensureBulletinClient(): PolkadotClient {
  if (bulletinClient) {
    return bulletinClient;
  }
  const bulletin = getActiveServicesConfig().bulletin;
  let provider;
  if (getBackend() !== "rpc-gateway") {
    const remote = createRemoteChainProvider(bulletin.genesis);
    if (remote === null) {
      throw new Error(
        "[dot.li bulletin] Protocol bridge does not support the Bulletin chain",
      );
    }
    provider = remote;
  } else {
    if (bulletin.rpcs.length === 0) {
      throw new Error(
        "[dot.li bulletin] Active network has no public Bulletin RPC endpoint",
      );
    }
    provider = getWsProvider([...bulletin.rpcs], {
      heartbeatTimeout: 120_000, // the default 40s is too aggressive through tunnels
    });
  }
  bulletinClient = createClient(provider);
  return bulletinClient;
}

const TX_TIMEOUT_MS = 120_000;

export async function submitPreimageAsUser(
  data: Uint8Array,
  signer: PolkadotSigner,
): Promise<void> {
  const client = ensureBulletinClient();
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
        isValid?: boolean;
      }) => {
        log.debug(`[dot.li bulletin] tx event`, { type: ev.type });
        if (resolved || ev.type !== "txBestBlocksState" || ev.found !== true) {
          return;
        }
        resolved = true;
        clearTimeout(timeoutId);
        subscription.unsubscribe();
        // When `found: true`, `ok` tells us whether the extrinsic dispatch
        // succeeded. `ok: false` means the tx landed but the pallet
        // rejected it (e.g. unauthorized signer, insufficient funds).
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
        reject(new Error("Bulletin tx failed", { cause: e }));
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
