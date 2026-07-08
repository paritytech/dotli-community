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
  const backend = getBackend();
  let provider;
  if (backend !== "rpc-gateway") {
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

// Keep this below the playground/e2e preimage timeout so tx stalls surface as
// host errors instead of generic test timeouts.
const TX_TIMEOUT_MS = 45_000;

interface TxSubscription {
  unsubscribe: () => void;
}

function unknownRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

interface TxWatchEvent {
  type: string;
  found?: boolean;
  ok?: boolean;
  dispatchError?: unknown;
  isValid?: boolean;
}

function compactTxError(error: unknown): string | null {
  const record = unknownRecord(error);
  const type = record?.type;
  if (typeof type !== "string") {
    return null;
  }
  const valueType = unknownRecord(record?.value)?.type;
  if (typeof valueType === "string") {
    return `${type}.${valueType}`;
  }
  return type;
}

function compactJsonTxErrorMessage(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    return compactTxError(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function describeTxError(error: unknown): string {
  if (error instanceof Error) {
    return (
      compactTxError(error) ??
      compactJsonTxErrorMessage(error.message) ??
      error.message
    );
  }
  if (typeof error === "string") {
    return compactJsonTxErrorMessage(error) ?? error;
  }
  const compact = compactTxError(error);
  if (compact !== null) {
    return compact;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function txDispatchErrorLabel(error: unknown): string {
  const compact = compactTxError(error);
  if (compact !== null) {
    return compact;
  }
  return describeTxError(error);
}

export async function submitPreimageAsUser(
  data: Uint8Array,
  signer: PolkadotSigner,
): Promise<void> {
  const client = ensureBulletinClient();
  const api = client.getUnsafeApi();
  const tx = api.tx.TransactionStorage.store({ data });

  await new Promise<void>((resolve, reject) => {
    let resolved = false;
    let subscription: TxSubscription | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      subscription?.unsubscribe();
      subscription = null;
    };

    timeoutId = setTimeout(() => {
      if (resolved) {
        return;
      }
      resolved = true;
      cleanup();
      reject(
        new Error(`Transaction timed out after ${String(TX_TIMEOUT_MS)}ms`),
      );
    }, TX_TIMEOUT_MS);

    try {
      subscription = tx.signSubmitAndWatch(signer).subscribe({
        next: (ev: TxWatchEvent) => {
          log.debug(`[dot.li bulletin] tx event`, { type: ev.type });
          if (
            resolved ||
            ev.type !== "txBestBlocksState" ||
            ev.found !== true
          ) {
            return;
          }
          resolved = true;
          cleanup();
          // When `found: true`, `ok` tells us whether the extrinsic dispatch
          // succeeded. `ok: false` means the tx landed but the pallet
          // rejected it (e.g. unauthorized signer, insufficient funds).
          if (ev.ok === false) {
            reject(
              new Error(
                `TransactionStorage.store dispatch failed: ${
                  ev.dispatchError === undefined
                    ? "Unknown"
                    : txDispatchErrorLabel(ev.dispatchError)
                }`,
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
          cleanup();
          const reason = describeTxError(e);
          log.error("[dot.li bulletin] tx failed", {
            reason,
            cause: e,
          });
          reject(new Error(`Bulletin tx failed: ${reason}`, { cause: e }));
        },
      });
    } catch (e) {
      resolved = true;
      cleanup();
      const reason = describeTxError(e);
      reject(
        new Error(`Bulletin tx subscription failed: ${reason}`, {
          cause: e,
        }),
      );
    }
  });
}
