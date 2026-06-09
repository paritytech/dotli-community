// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Bulletin Paseo chain connection for preimage operations.
//
// Provides a smoldot-backed polkadot-api client for the Bulletin Paseo
// parachain, used to submit preimage data via TransactionStorage.store().
// Uses Alice test signer (DEV_PHRASE) matching the browser host's current
// implementation. TODO: replace with production signer.

import { getSmProvider } from "polkadot-api/sm-provider";
import { createClient, type PolkadotClient } from "polkadot-api";
import { getPolkadotSigner } from "@polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
  DEV_PHRASE,
  entropyToMiniSecret,
  mnemonicToEntropy,
} from "@polkadot-labs/hdkd-helpers";
import { getBulletinChain, makeNonRemovingChain } from "./smoldot";
import { log } from "@dotli/shared/log";

// Bulletin client singleton.
//
// Neither the cached client nor the in-flight promise are published to
// the outer module until `getFinalizedBlock()` resolves. A failure
// before sync clears both so the next caller retries from scratch
// instead of inheriting a dead client.

let bulletinClient: PolkadotClient | null = null;
let bulletinClientPromise: Promise<PolkadotClient> | null = null;

export async function ensureBulletinClient(): Promise<PolkadotClient> {
  if (bulletinClient) {
    return bulletinClient;
  }
  bulletinClientPromise ??= (async () => {
    const chain = await getBulletinChain();
    const nonRemoving = makeNonRemovingChain(chain);
    const provider = getSmProvider(() => nonRemoving);
    const candidate = createClient(provider);
    try {
      await candidate.getFinalizedBlock();
    } catch (err) {
      try {
        candidate.destroy();
        // eslint-disable-next-line no-restricted-syntax -- best-effort teardown of a never-fully-initialised client; the real error (the pre-sync failure) is rethrown below.
      } catch {
        /* already dead */
      }
      bulletinClient = null;
      bulletinClientPromise = null;
      throw err;
    }
    bulletinClient = candidate;
    log.warn("[dot.li bulletin] Client synced to finalized block");
    return bulletinClient;
  })().catch((err: unknown) => {
    bulletinClientPromise = null;
    throw err;
  });
  return bulletinClientPromise;
}

// Test signer (Alice).
// TODO: Replace with production signer (People chain XCM authorization
// and unsigned submission). For testing on Paseo, Alice's account is
// pre-authorized via authorize_account.

export function getTestSigner(): ReturnType<typeof getPolkadotSigner> {
  const entropy = mnemonicToEntropy(DEV_PHRASE);
  const miniSecret = entropyToMiniSecret(entropy);
  const derive = sr25519CreateDerive(miniSecret);
  const alice = derive("//Alice");

  return getPolkadotSigner(alice.publicKey, "Sr25519", (input: Uint8Array) =>
    alice.sign(input),
  );
}

// Preimage transaction submission.

const TX_TIMEOUT_MS = 120_000;

export async function submitPreimageTransaction(
  data: Uint8Array,
  signer: ReturnType<typeof getPolkadotSigner>,
): Promise<void> {
  const client = await ensureBulletinClient();
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
