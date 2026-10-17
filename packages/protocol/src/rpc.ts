// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Requests to the protocol frame and their answers.

import { m, spans as S } from '@dotli/metrics';
import type { ResolvePhase } from '@dotli/resolver';
import { createPendingReplies, errorName, log, toError, withTimeout } from '@dotli/shared';
import { isSharedAuthRequestMethod, isSharedModeRequestMethod, isSharedWalletRequestMethod } from './auth-storage.js';
import { ProtocolRequestError } from './errors.js';
import type { ProtocolFrame } from './frame.js';
import {
  isProgressPayloadValid,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
  type ProtocolRequestMethod,
  type ProtocolResponseMap,
} from './messages.js';
import { DEFAULT_TIMEOUT_MS, METHOD_TIMEOUTS, UNTIMED_METHODS } from './method-timeouts.js';

/** What a request leaves with its wait, for the answer and its progress. */
interface RequestMeta {
  method: ProtocolRequestMethod;
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
  ): Promise<ProtocolResponseMap[M]>;
}

export function createFrameRpc(frame: RpcFrame): FrameRpc {
  const replies = createPendingReplies<string, unknown, RequestMeta>();

  frame.onEnvelope(msg => {
    if (msg.kind === 'progress') {
      if (isProgressPayloadValid(msg)) {
        replies.meta(msg.id)?.onProgress?.(msg.phase);
      }
      return;
    }
    if (msg.kind !== 'response') {
      return;
    }
    const meta = replies.meta(msg.id);
    if (meta === undefined) {
      return;
    }
    if (msg.ok) {
      replies.resolve(msg.id, msg.result);
      return;
    }
    replies.reject(
      msg.id,
      new ProtocolRequestError(
        msg.error || 'Unknown protocol error',
        // A bare `"Error"` carries nothing, and would cost us the
        // "crossed the protocol boundary" signal dashboards filter on.
        msg.errorName !== undefined && msg.errorName !== 'Error' ? msg.errorName : 'ProtocolResponseError',
        meta.method,
        typeof msg.errorStack === 'string' ? msg.errorStack : undefined,
      ),
    );
  });

  // A request whose wait settled before a loss resumes after it, so each loss is kept for the requests not posted yet.
  let losses = 0;
  let lastLoss: Error | undefined;

  // The frame that would answer is gone, so a request left to its timer would only fail later.
  frame.onLost(error => {
    losses += 1;
    lastLoss = error;
    replies.rejectAll(() => error);
  });

  return {
    async request(method, payload, onProgress) {
      const sharedStore =
        isSharedAuthRequestMethod(method) || isSharedModeRequestMethod(method) || isSharedWalletRequestMethod(method);
      const since = losses;
      await frame.whenUp(sharedStore ? 'listening' : 'ready');
      // The frame it waited for was dropped in the same turn, and the one replacing it would drop a message posted
      // before its page loads.
      if (losses !== since && lastLoss !== undefined) {
        throw lastLoss;
      }

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
          m.count(S.PROTOCOL_REQUEST, { outcome, method, reason: errorName(err) ?? 'unknown' });
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

      const reply = replies.wait(id, { method, onProgress });
      let timedOut: Error | undefined;
      const answered =
        timeoutMs === null
          ? reply
          : withTimeout(reply, timeoutMs, () => {
              timedOut = new ProtocolRequestError(
                `Protocol request "${method}" timed out after ${String(timeoutMs)}ms`,
                'ProtocolTimeoutError',
                method,
              );
              replies.reject(id, timedOut);
              return timedOut;
            });
      try {
        const value = await answered;
        settled('ok');
        // The one place an answer gets its type: it crossed postMessage untyped, so the map is only as right as the specs.
        return value as ProtocolResponseMap[typeof method];
      } catch (reason: unknown) {
        const err = toError(reason);
        settled(err === timedOut ? 'timeout' : 'error', err);
        throw err;
      }
    },
  };
}
