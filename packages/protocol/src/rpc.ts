// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Requests to the protocol frame and their answers.

import { m, spans as S } from '@dotli/metrics';
import type { ResolvePhase } from '@dotli/resolver';
import { log } from '@dotli/shared';
import { isSharedAuthRequestMethod, isSharedModeRequestMethod, isSharedWalletRequestMethod } from './auth-storage.js';
import { ProtocolRequestError } from './errors.js';
import type { ProtocolFrame } from './frame.js';
import {
  isProgressPayloadValid,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
  type ProtocolRequestMethod,
} from './messages.js';
import { DEFAULT_TIMEOUT_MS, METHOD_TIMEOUTS, UNTIMED_METHODS } from './method-timeouts.js';

interface PendingRequest {
  method: ProtocolRequestMethod;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onProgress?: ((phase: ResolvePhase) => void) | undefined;
}

/**
 * Page load steps, breadcrumbed when sent and settled so a failed load's trail names what it waited on.
 * Storage and chain traffic is per product call and would crowd them out.
 */
const TRAILED_METHODS: ReadonlySet<ProtocolRequestMethod> = new Set<ProtocolRequestMethod>([
  'warmup',
  'chainConnect',
  'resolveDotName',
  'resolveOwner',
  'resolveExecutableManifest',
  'resolveRootManifest',
]);

export function createRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** What requests need of the frame. */
export type RpcFrame = Pick<ProtocolFrame, 'whenUp' | 'post' | 'onEnvelope' | 'onLost'>;

export interface FrameRpc {
  /**
   * Posts once the frame can answer: listening for the shared store, ready for everything else. Rejects at once when
   * the frame is down or goes down before the answer.
   */
  request<M extends ProtocolRequestMethod>(
    method: M,
    payload: ProtocolRequestMap[M],
    onProgress?: (phase: ResolvePhase) => void,
  ): Promise<unknown>;
}

export function createFrameRpc(frame: RpcFrame): FrameRpc {
  const pendingRequests = new Map<string, PendingRequest>();

  frame.onEnvelope(msg => {
    if (msg.kind === 'progress') {
      if (isProgressPayloadValid(msg)) {
        pendingRequests.get(msg.id)?.onProgress?.(msg.phase);
      }
      return;
    }
    if (msg.kind !== 'response') {
      return;
    }
    const pending = pendingRequests.get(msg.id);
    if (!pending) {
      return;
    }
    pendingRequests.delete(msg.id);
    if (msg.ok) {
      pending.resolve(msg.result);
      return;
    }
    pending.reject(
      new ProtocolRequestError(
        msg.error || 'Unknown protocol error',
        // A bare `"Error"` carries nothing, and would cost us the
        // "crossed the protocol boundary" signal dashboards filter on.
        msg.errorName !== undefined && msg.errorName !== 'Error' ? msg.errorName : 'ProtocolResponseError',
        pending.method,
        typeof msg.errorStack === 'string' ? msg.errorStack : undefined,
      ),
    );
  });

  // The frame that would answer is gone, so a request left to its timer would only fail later.
  frame.onLost(error => {
    const inFlight = [...pendingRequests.values()];
    pendingRequests.clear();
    for (const pending of inFlight) {
      pending.reject(error);
    }
  });

  return {
    async request(method, payload, onProgress) {
      const sharedStore =
        isSharedAuthRequestMethod(method) || isSharedModeRequestMethod(method) || isSharedWalletRequestMethod(method);
      await frame.whenUp(sharedStore ? 'listening' : 'ready');

      const id = createRequestId();
      const timeoutMs = UNTIMED_METHODS.has(method) ? null : (METHOD_TIMEOUTS[method] ?? DEFAULT_TIMEOUT_MS);
      const envelope: ProtocolRequestEnvelope<typeof method> = {
        namespace: 'dotli:protocol',
        kind: 'request',
        id,
        method,
        payload,
        ...(timeoutMs === null ? {} : { deadlineMs: Date.now() + timeoutMs }),
      };
      // Throws when the frame vanished since the wait, before anything is counted for the request.
      frame.post(envelope);
      // `chainSend` is fire-and-ack, one per product JSON-RPC message: timed, it
      // would swamp the resolution and connect round trips this span measures.
      const stopReq = method === 'chainSend' ? (): number => 0 : m.timer(S.PROTOCOL_REQUEST);
      const trailed = TRAILED_METHODS.has(method);
      const sentAt = performance.now();
      const settled = (outcome: 'ok' | 'error' | 'timeout', err?: Error): void => {
        stopReq();
        if (outcome !== 'ok') {
          m.count(S.PROTOCOL_REQUEST, { outcome, method });
        }
        if (trailed) {
          log.event(`${method} ${outcome === 'ok' ? 'done' : outcome === 'timeout' ? 'timed out' : 'failed'}`, {
            flow: 'protocol',
            ms: Math.round(performance.now() - sentAt),
            ...(err !== undefined ? { error: `${err.name}: ${err.message}`.slice(0, 200) } : {}),
          });
        }
      };
      if (trailed) {
        log.event(`${method} sent`, {
          flow: 'protocol',
          ...(timeoutMs === null ? {} : { timeout_ms: timeoutMs }),
        });
      }

      return new Promise((resolve, reject) => {
        const timer =
          timeoutMs === null
            ? null
            : setTimeout(() => {
                pendingRequests.delete(id);
                const err = new ProtocolRequestError(
                  `Protocol request "${method}" timed out after ${String(timeoutMs)}ms`,
                  'ProtocolTimeoutError',
                  method,
                );
                settled('timeout', err);
                reject(err);
              }, timeoutMs);

        pendingRequests.set(id, {
          method,
          resolve: value => {
            if (timer !== null) {
              clearTimeout(timer);
            }
            settled('ok');
            resolve(value);
          },
          reject: (reason?: unknown) => {
            if (timer !== null) {
              clearTimeout(timer);
            }
            const err = reason instanceof Error ? reason : new Error(String(reason));
            settled('error', err);
            reject(err);
          },
          onProgress,
        });
      });
    },
  };
}
