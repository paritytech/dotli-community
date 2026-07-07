// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Bulletin Paseo chain connection for preimage operations.
//
// Provides a smoldot-backed polkadot-api client for the Bulletin Paseo
// parachain, used to submit preimage data via TransactionStorage.store().
// Uses Alice test signer (DEV_PHRASE) matching the browser host's current
// implementation. TODO: replace with production signer.

import {
  AccountId,
  createClient,
  Enum,
  type PolkadotClient,
} from "polkadot-api";
import { getSmProvider } from "polkadot-api/sm-provider";
import { getPolkadotSigner } from "@polkadot-api/signer";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
  DEV_PHRASE,
  entropyToMiniSecret,
  mnemonicToEntropy,
} from "@polkadot-labs/hdkd-helpers";
import { log } from "@dotli/shared/log";
import { getBulletinChain, makeNonRemovingChain } from "./smoldot";

let bulletinClient: PolkadotClient | null = null;
let bulletinClientPromise: Promise<PolkadotClient> | null = null;

export async function ensureBulletinClient(): Promise<PolkadotClient> {
  if (bulletinClient !== null) {
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
        // eslint-disable-next-line no-restricted-syntax -- best-effort teardown of a never-fully-initialised client; the real error is rethrown below.
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
const DEFAULT_AUTH_TRANSACTIONS = 100;
const DEFAULT_AUTH_BYTES = 100 * 1024 * 1024;

interface WatchedTransaction {
  signSubmitAndWatch(signer: ReturnType<typeof getPolkadotSigner>): {
    subscribe(observer: {
      next(ev: {
        type: string;
        found?: boolean;
        ok?: boolean;
        dispatchError?: { type: string; value: unknown };
      }): void;
      error(e: unknown): void;
    }): { unsubscribe(): void };
  };
}

interface StorageAuthorization {
  extent: {
    transactions: number;
    bytes: bigint;
  };
  expiration: number;
}

interface SubmitTransactionOptions {
  resolveOnBroadcast?: boolean;
}

async function ensureStorageAuthorization(
  client: PolkadotClient,
  api: ReturnType<PolkadotClient["getUnsafeApi"]>,
  signer: ReturnType<typeof getPolkadotSigner>,
  dataLength: number,
): Promise<void> {
  const finalized = await client.getFinalizedBlock();
  const signerAddress = AccountId().dec(signer.publicKey);
  const authKey = Enum("Account", signerAddress);
  const authorization =
    (await api.query.TransactionStorage.Authorizations.getValue(authKey)) as
      | StorageAuthorization
      | undefined;

  if (
    authorization &&
    authorization.expiration > finalized.number &&
    authorization.extent.transactions > 0 &&
    authorization.extent.bytes >= BigInt(dataLength)
  ) {
    return;
  }

  const tx = api.tx.TransactionStorage.authorize_account({
    who: signerAddress,
    transactions: DEFAULT_AUTH_TRANSACTIONS,
    bytes: BigInt(DEFAULT_AUTH_BYTES),
  });
  await submitTransaction(tx, signer, "Bulletin authorization tx failed");
}

export async function submitPreimageTransaction(
  data: Uint8Array,
  signer: ReturnType<typeof getPolkadotSigner>,
): Promise<void> {
  const client = await ensureBulletinClient();
  const api = client.getUnsafeApi();
  await ensureStorageAuthorization(client, api, signer, data.byteLength);
  const tx = api.tx.TransactionStorage.store({ data });

  await submitTransaction(tx, signer, "Bulletin tx failed", {
    resolveOnBroadcast: true,
  });
}

async function submitTransaction(
  tx: WatchedTransaction,
  signer: ReturnType<typeof getPolkadotSigner>,
  failureMessage: string,
  options: SubmitTransactionOptions = {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const state = { resolved: false };
    let subscription: { unsubscribe(): void } | null = null;

    const cleanup = (): void => {
      clearTimeout(timeoutId);
      if (subscription !== null) {
        subscription.unsubscribe();
      }
    };

    const settle = (complete: () => void): void => {
      if (state.resolved) {
        return;
      }
      state.resolved = true;
      cleanup();
      complete();
    };

    const timeoutId = setTimeout(() => {
      settle(() => {
        reject(new Error("Transaction timed out"));
      });
    }, TX_TIMEOUT_MS);

    subscription = tx.signSubmitAndWatch(signer).subscribe({
      next: (ev: {
        type: string;
        found?: boolean;
        ok?: boolean;
        dispatchError?: { type: string; value: unknown };
      }) => {
        log.debug("[dot.li bulletin] tx event", { type: ev.type });
        if (options.resolveOnBroadcast === true && ev.type === "broadcasted") {
          settle(() => {
            resolve();
          });
          return;
        }
        if (
          state.resolved ||
          ev.type !== "txBestBlocksState" ||
          ev.found !== true
        ) {
          return;
        }
        if (ev.ok === false) {
          settle(() => {
            reject(
              new Error(
                `TransactionStorage.store dispatch failed: ${ev.dispatchError?.type ?? "Unknown"}`,
                { cause: ev.dispatchError },
              ),
            );
          });
          return;
        }
        settle(() => {
          resolve();
        });
      },
      error: (e: unknown) => {
        settle(() => {
          reject(new Error(failureMessage, { cause: e }));
        });
      },
    });

    if (state.resolved) {
      subscription.unsubscribe();
    }
  });
}
