// dot.li — TEMPORARY trusted-RPC fallback for light-client extrinsic submission
//
// Remove this module once smoldot can validate the affected calls itself.
//
// smoldot validates every transaction locally before broadcasting it, from a
// call proof a full node returns. For some Asset Hub calls (the PGAS
// `claim_pgas` general extrinsic, and pallet-revive dry-runs) smoldot 3.4.1
// and 3.6.0 reject every proof with `MissingProofEntry`, ban the peer, and
// finally report the extrinsic `"dropped"`. The same bytes validate on, and
// are included by, the chain's trusted RPC node. See ADR 0002, "Temporary
// light-client submission fallback", for the reproduction and removal
// criteria.
//
// Scope is deliberately narrow: only a legacy `author_submitAndWatchExtrinsic`
// whose light-client watch ends in `"dropped"` is resent, unchanged, to the
// trusted RPC node. The RPC node can see and censor the transaction but not
// forge it; the core still verifies the outcome through light-client state,
// which is why an inclusion update is held until smoldot knows that block.

import type {
  JsonRpcConnection,
  JsonRpcProvider,
} from "@polkadot-api/json-rpc-provider";
import { log } from "@dotli/shared/log";

const SUBMIT = "author_submitAndWatchExtrinsic";
const UPDATE = "author_extrinsicUpdate";
const LIGHT_CLIENT_BLOCK_WAIT_MS = 30_000;
const LIGHT_CLIENT_BLOCK_POLL_MS = 1_000;
const TERMINAL_UPDATES = new Set([
  "finalized",
  "invalid",
  "dropped",
  "usurped",
  "finalityTimeout",
]);

type JsonRpcMessage = Record<string, unknown>;

interface WatchedSubmission {
  extrinsic: string;
  fallback?: { disconnect: () => void };
}

function asMessage(value: unknown): JsonRpcMessage | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRpcMessage)
    : null;
}

function updateKind(result: unknown): string | null {
  if (typeof result === "string") {
    return result;
  }
  const object = asMessage(result);
  const keys = object === null ? [] : Object.keys(object);
  return keys.length === 1 ? (keys[0] ?? null) : null;
}

/**
 * Wrap a light-client provider so a dropped legacy extrinsic watch is resent
 * through `createTrustedProvider`. TEMPORARY; see the module comment.
 */
export function withTrustedSubmitFallback(
  lightClient: JsonRpcProvider<unknown>,
  createTrustedProvider: () => JsonRpcProvider<unknown> | null,
  chainLabel: string,
): JsonRpcProvider<unknown> {
  return (onMessage) => {
    const pendingSubmits = new Map<unknown, string>();
    const watches = new Map<string, WatchedSubmission>();
    const blockLookups = new Map<string, (known: boolean) => void>();
    let lookupCounter = 0;
    let disconnected = false;

    const waitForLightClientBlock = async (
      blockHash: string,
    ): Promise<void> => {
      const deadline = Date.now() + LIGHT_CLIENT_BLOCK_WAIT_MS;
      while (!disconnected && Date.now() < deadline) {
        const id = `dotli-submit-fallback:${String(++lookupCounter)}`;
        const known = Promise.withResolvers<boolean>();
        blockLookups.set(id, known.resolve);
        upstream.send({
          jsonrpc: "2.0",
          id,
          method: "chain_getHeader",
          params: [blockHash],
        });
        if (await known.promise) {
          return;
        }
        const pause = Promise.withResolvers<undefined>();
        setTimeout(() => {
          pause.resolve(undefined);
        }, LIGHT_CLIENT_BLOCK_POLL_MS);
        await pause.promise;
      }
    };

    const resubmitThroughTrustedRpc = (
      subscription: string,
      watch: WatchedSubmission,
    ): boolean => {
      const trusted = createTrustedProvider();
      if (trusted === null) {
        return false;
      }
      log.warn(
        `[dot.li] TEMPORARY: the light client dropped an extrinsic on ${chainLabel}; resubmitting the same bytes through the trusted RPC node (see ADR 0002).`,
      );
      let trustedSubscription: unknown;
      let relay = Promise.resolve();
      const connection: JsonRpcConnection<unknown> = trusted((raw) => {
        const message = asMessage(raw);
        if (message === null || disconnected) {
          return;
        }
        if (message.id === "dotli-submit-fallback") {
          if (typeof message.result === "string") {
            trustedSubscription = message.result;
            return;
          }
          // The trusted node refused the submission outright.
          relay = relay.then(() => {
            onMessage({
              jsonrpc: "2.0",
              method: UPDATE,
              params: { subscription, result: "invalid" },
            });
          });
          connection.disconnect();
          return;
        }
        const params = asMessage(message.params);
        if (
          message.method !== UPDATE ||
          params === null ||
          params.subscription !== trustedSubscription
        ) {
          return;
        }
        const result = params.result;
        const kind = updateKind(result);
        const included =
          asMessage(result)?.inBlock ?? asMessage(result)?.finalized;
        relay = relay.then(async () => {
          if (typeof included === "string") {
            await waitForLightClientBlock(included);
          }
          if (!disconnected) {
            onMessage({
              jsonrpc: "2.0",
              method: UPDATE,
              params: { subscription, result },
            });
          }
        });
        if (kind !== null && TERMINAL_UPDATES.has(kind)) {
          void relay.then(() => {
            connection.disconnect();
          });
        }
      });
      watch.fallback = connection;
      connection.send({
        jsonrpc: "2.0",
        id: "dotli-submit-fallback",
        method: SUBMIT,
        params: [watch.extrinsic],
      });
      return true;
    };

    const upstream = lightClient((raw) => {
      const message = asMessage(raw);
      if (message === null) {
        onMessage(raw);
        return;
      }
      if (typeof message.id === "string" && blockLookups.has(message.id)) {
        const resolve = blockLookups.get(message.id);
        blockLookups.delete(message.id);
        resolve?.(asMessage(message.result) !== null);
        return;
      }
      if (message.id !== undefined && pendingSubmits.has(message.id)) {
        const extrinsic = pendingSubmits.get(message.id);
        pendingSubmits.delete(message.id);
        if (typeof message.result === "string" && extrinsic !== undefined) {
          watches.set(message.result, { extrinsic });
        }
      }
      const params = asMessage(message.params);
      if (
        message.method === UPDATE &&
        params !== null &&
        typeof params.subscription === "string"
      ) {
        const watch = watches.get(params.subscription);
        if (watch?.fallback !== undefined) {
          // The light-client watch is dead; the fallback owns this id now.
          return;
        }
        if (
          watch !== undefined &&
          params.result === "dropped" &&
          resubmitThroughTrustedRpc(params.subscription, watch)
        ) {
          return;
        }
        if (
          watch !== undefined &&
          TERMINAL_UPDATES.has(updateKind(params.result) ?? "")
        ) {
          watches.delete(params.subscription);
        }
      }
      onMessage(raw);
    });

    return {
      send(raw) {
        const message = asMessage(raw);
        const params = Array.isArray(message?.params) ? message.params : [];
        if (message?.method === SUBMIT && typeof params[0] === "string") {
          pendingSubmits.set(message.id, params[0]);
        } else if (
          message?.method === "author_unwatchExtrinsic" &&
          typeof params[0] === "string"
        ) {
          watches.get(params[0])?.fallback?.disconnect();
          watches.delete(params[0]);
        }
        upstream.send(raw);
      },
      disconnect() {
        disconnected = true;
        for (const watch of watches.values()) {
          watch.fallback?.disconnect();
        }
        watches.clear();
        for (const resolve of blockLookups.values()) {
          resolve(false);
        }
        blockLookups.clear();
        upstream.disconnect();
      },
    };
  };
}
