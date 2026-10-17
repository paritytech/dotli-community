// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Name and manifest resolution done by the protocol frame's light client.

import type { ResolvePhase } from '@dotli/resolver';
import { realTimers, withTimeout, type Timers } from '@dotli/shared';
import { PROTOCOL_ERRORS } from './errors.js';
import type { ProtocolFrame } from './frame.js';
import { budgetOf, DEFAULT_TIMEOUT_MS } from './method-timeouts.js';
import { asCallError, callTimeoutError, startCallTrail, type FrameRpc } from './rpc.js';

// A timed method, so the default is never taken.
const RESOLVE_BUDGET_MS = budgetOf('resolveDotName') ?? DEFAULT_TIMEOUT_MS;

export interface RemoteResolveDeps {
  frame: Pick<ProtocolFrame, 'whenUp'>;
  rpc: FrameRpc;
  timers?: Timers;
}

export function createRemoteResolve({ frame, rpc, timers = realTimers }: RemoteResolveDeps) {
  /**
   * Hears the frame's resolve phases, then its result. The budget runs once the frame is ready, and a resolution that
   * outlives it is unsubscribed, so the frame stops it.
   */
  async function resolveDotName(label: string, onPhase?: (phase: ResolvePhase) => void): Promise<string | null> {
    const transport = await frame.whenUp('ready');
    const giveUp = new AbortController();
    const trail = startCallTrail('resolveDotName', RESOLVE_BUDGET_MS, timers);
    let timedOut: Error | undefined;
    const resolved = new Promise<string | null>((resolve, reject) => {
      let answered = false;
      const resolution = transport.subscribe(
        'resolveDotName',
        { label },
        event => {
          if (event.tag === 'phase') {
            onPhase?.(event.value);
            return;
          }
          answered = true;
          resolve(event.value);
        },
        { deadlineMs: timers.now() + RESOLVE_BUDGET_MS, signal: giveUp.signal },
      );
      // The frame ends a resolution cleanly once it sent the result, and an end before it is a failure.
      resolution.onEnd(error => {
        if (!answered) {
          reject(error ?? new Error(PROTOCOL_ERRORS.RESOLUTION_ENDED));
        }
      });
    });
    try {
      const name = await withTimeout(
        resolved,
        RESOLVE_BUDGET_MS,
        () => {
          timedOut = callTimeoutError('resolveDotName', RESOLVE_BUDGET_MS);
          giveUp.abort(timedOut);
          return timedOut;
        },
        timers,
      );
      trail.settled('ok');
      return name;
    } catch (reason: unknown) {
      const err = asCallError(reason);
      trail.settled(reason === timedOut ? 'timeout' : 'error', err);
      throw err;
    }
  }

  return {
    async warmupProtocol(): Promise<void> {
      await rpc.request('warmup', undefined);
    },
    resolveDotNameRemote: resolveDotName,
    resolveOwnerRemote: (label: string) => rpc.request('resolveOwner', { label }),
    resolveExecutableManifestRemote: (label: string, kind: 'app' | 'widget' | 'worker') =>
      rpc.request('resolveExecutableManifest', { label, kind }),
    resolveRootManifestRemote: (label: string) => rpc.request('resolveRootManifest', { label }),
  };
}
