// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// TEMPORARY trusted-RPC fallback for light-client extrinsic submission. Only the experimental local
// wallet signs and submits in the page, so the host pool wraps its light-client transports with this
// only on a page booted in local wallet mode.
//
// Why: smoldot validates every transaction locally before broadcasting it, from a call proof a full
// node returns. For some Asset Hub calls (the PGAS `claim_pgas` general extrinsic, and pallet-revive
// dry-runs) smoldot 3.4.1 and 3.6.0 reject every proof with `MissingProofEntry`, ban the peer, and
// finally report the extrinsic `"dropped"`. The same bytes validate on, and are included by, the
// chain's trusted RPC node.
//
// Reproduce: on a light-client backend in local wallet mode, submit `claim_pgas` on Asset Hub. The
// light-client watch ends `"dropped"` and the console warns that the bytes went to the trusted node.
//
// Remove this module, and its wrapping in `Chain.ts`, once the bundled smoldot includes such a call
// from its own `author_submitAndWatchExtrinsic` with this module bypassed.
//
// Scope is deliberately narrow: only a legacy `author_submitAndWatchExtrinsic` whose light-client
// watch ends in `"dropped"` is resent, unchanged, to the trusted RPC node. The RPC node can see and
// censor the transaction but not forge it; the core still verifies the outcome through light-client
// state, which is why an inclusion update is held until smoldot knows that block.

import type { JsonRpcConnection, JsonRpcMessage, JsonRpcProvider } from '@polkadot-api/json-rpc-provider';
import { log } from '@dotli/shared';

const SUBMIT = 'author_submitAndWatchExtrinsic';
const UPDATE = 'author_extrinsicUpdate';
const FALLBACK_SUBMIT_ID = 'dotli-submit-fallback';
const LOOKUP_ID_PREFIX = `${FALLBACK_SUBMIT_ID}:`;
const LIGHT_CLIENT_BLOCK_WAIT_MS = 30_000;
const LIGHT_CLIENT_BLOCK_POLL_MS = 1_000;
const TERMINAL_UPDATES: Record<string, true> = {
  finalized: true,
  invalid: true,
  dropped: true,
  usurped: true,
  finalityTimeout: true,
};

type JsonRpcObject = Record<string, unknown>;

interface WatchedSubmission {
  extrinsic: string;
  fallback?: { disconnect: () => void };
}

function asObject(value: unknown): JsonRpcObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRpcObject) : null;
}

function updateKind(result: unknown): string | null {
  if (typeof result === 'string') {
    return result;
  }
  const object = asObject(result);
  const keys = object === null ? [] : Object.keys(object);
  return keys.length === 1 ? (keys[0] ?? null) : null;
}

function extrinsicUpdate(subscription: string, result: unknown): JsonRpcMessage {
  return { jsonrpc: '2.0', method: UPDATE, params: { subscription, result } };
}

/**
 * Wrap a light-client provider so a dropped legacy extrinsic watch is resent through
 * `createTrustedProvider`. TEMPORARY; see the module comment.
 */
export function withTrustedSubmitFallback(
  lightClient: JsonRpcProvider,
  createTrustedProvider: () => JsonRpcProvider | null,
  chainLabel: string,
): JsonRpcProvider {
  return onMessage => {
    const pendingSubmits = new Map<unknown, string>();
    const watches = new Map<string, WatchedSubmission>();
    const blockLookups = new Map<string, (known: boolean) => void>();
    let lookupCounter = 0;
    let disconnected = false;

    const waitForLightClientBlock = (blockHash: string, signal: AbortSignal): Promise<boolean> => {
      if (signal.aborted || disconnected) {
        return Promise.resolve(false);
      }
      return new Promise<boolean>(resolve => {
        let lookupId: string | undefined;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (known: boolean): void => {
          clearTimeout(deadlineTimer);
          clearTimeout(pollTimer);
          signal.removeEventListener('abort', cancel);
          if (lookupId !== undefined) {
            blockLookups.delete(lookupId);
          }
          resolve(known);
        };
        const cancel = (): void => {
          finish(false);
        };
        const deadlineTimer = setTimeout(cancel, LIGHT_CLIENT_BLOCK_WAIT_MS);
        signal.addEventListener('abort', cancel, { once: true });
        const poll = (): void => {
          lookupId = `${LOOKUP_ID_PREFIX}${String(++lookupCounter)}`;
          blockLookups.set(lookupId, known => {
            lookupId = undefined;
            if (known) {
              finish(true);
            } else {
              pollTimer = setTimeout(poll, LIGHT_CLIENT_BLOCK_POLL_MS);
            }
          });
          try {
            upstream.send({ jsonrpc: '2.0', id: lookupId, method: 'chain_getHeader', params: [blockHash] });
          } catch (error) {
            log.warn(`[dot.li] submit fallback could not ask the light client for a block on ${chainLabel}:`, error);
            finish(false);
          }
        };
        poll();
      });
    };

    const resubmitThroughTrustedRpc = (subscription: string, watch: WatchedSubmission): boolean => {
      const trusted = createTrustedProvider();
      if (trusted === null) {
        return false;
      }
      log.warn(
        `[dot.li] TEMPORARY: the light client dropped an extrinsic on ${chainLabel}; resubmitting the same bytes through the trusted RPC node.`,
      );
      let trustedSubscription: unknown;
      let relay = Promise.resolve();
      const cancellation = new AbortController();
      const isActive = (): boolean => !disconnected && watches.get(subscription) === watch;
      const stop = (): void => {
        watches.delete(subscription);
        watch.fallback?.disconnect();
      };
      const connection: JsonRpcConnection = trusted(raw => {
        const message = asObject(raw);
        if (message === null || !isActive()) {
          return;
        }
        if (message['id'] === FALLBACK_SUBMIT_ID) {
          if (typeof message['result'] === 'string') {
            trustedSubscription = message['result'];
            return;
          }
          // The trusted node refused the submission outright.
          relay = relay.then(() => {
            if (!isActive()) {
              return;
            }
            stop();
            onMessage(extrinsicUpdate(subscription, 'invalid'));
          });
          return;
        }
        const params = asObject(message['params']);
        if (message['method'] !== UPDATE || params === null || params['subscription'] !== trustedSubscription) {
          return;
        }
        const result = params['result'];
        const kind = updateKind(result);
        const included = asObject(result)?.['inBlock'] ?? asObject(result)?.['finalized'];
        relay = relay.then(async () => {
          if (!isActive()) {
            return;
          }
          if (typeof included === 'string' && !(await waitForLightClientBlock(included, cancellation.signal))) {
            // The trusted RPC cannot establish inclusion on its own. End the watch, rather than
            // claiming success when light-client sync fails.
            if (isActive()) {
              stop();
              onMessage(extrinsicUpdate(subscription, 'dropped'));
            }
            return;
          }
          if (isActive()) {
            if (kind !== null && TERMINAL_UPDATES[kind] === true) {
              stop();
            }
            onMessage(extrinsicUpdate(subscription, result));
          }
        });
      });
      watch.fallback = {
        disconnect() {
          cancellation.abort();
          connection.disconnect();
        },
      };
      connection.send({ jsonrpc: '2.0', id: FALLBACK_SUBMIT_ID, method: SUBMIT, params: [watch.extrinsic] });
      return true;
    };

    const upstream = lightClient(raw => {
      const message = asObject(raw);
      if (message === null) {
        onMessage(raw);
        return;
      }
      const id = message['id'];
      if (typeof id === 'string' && id.startsWith(LOOKUP_ID_PREFIX)) {
        const resolve = blockLookups.get(id);
        blockLookups.delete(id);
        resolve?.(asObject(message['result']) !== null);
        return;
      }
      if (id !== undefined && pendingSubmits.has(id)) {
        const extrinsic = pendingSubmits.get(id);
        pendingSubmits.delete(id);
        if (typeof message['result'] === 'string' && extrinsic !== undefined) {
          watches.set(message['result'], { extrinsic });
        }
      }
      const params = asObject(message['params']);
      if (message['method'] === UPDATE && params !== null && typeof params['subscription'] === 'string') {
        const subscription = params['subscription'];
        const watch = watches.get(subscription);
        if (watch?.fallback !== undefined) {
          // The light-client watch is dead; the fallback owns this id now.
          return;
        }
        if (watch !== undefined && params['result'] === 'dropped' && resubmitThroughTrustedRpc(subscription, watch)) {
          return;
        }
        if (watch !== undefined && TERMINAL_UPDATES[updateKind(params['result']) ?? ''] === true) {
          watches.delete(subscription);
        }
      }
      onMessage(raw);
    });

    return {
      send(message) {
        const params: unknown[] = Array.isArray(message.params) ? (message.params as unknown[]) : [];
        const first = params[0];
        if (message.method === SUBMIT && typeof first === 'string') {
          pendingSubmits.set(message.id, first);
        } else if (message.method === 'author_unwatchExtrinsic' && typeof first === 'string') {
          watches.get(first)?.fallback?.disconnect();
          watches.delete(first);
        }
        upstream.send(message);
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
