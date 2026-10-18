// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Name and manifest resolution done by the protocol frame's light client.

import type { ResolvePhase } from '@dotli/resolver';

import { PROTOCOL_ERRORS } from './errors.js';

import type { FrameRpc } from './rpc.js';
import { protocolSchema } from './schema.js';
import { subscribe } from './subscription.js';

const { dotName, owner, executableManifest, rootManifest } = protocolSchema.traits.resolve;

export interface RemoteResolveDeps {
  rpc: FrameRpc;
}

export function createRemoteResolve({ rpc }: RemoteResolveDeps) {
  /**
   * Hears the frame's resolve phases, then its result, and unsubscribes on the result. The budget runs once the frame
   * is ready, and a resolution that outlives it is unsubscribed, so the frame stops it.
   */
  function resolveDotName(label: string, onPhase?: (phase: ResolvePhase) => void): Promise<string | null> {
    return rpc.call(
      dotName,
      (transport, signal) =>
        new Promise<string | null>((resolve, reject) => {
          let answered = false;
          const stop = subscribe(
            transport,
            dotName,
            { label },
            {
              receive: event => {
                if (event.tag === 'phase') {
                  onPhase?.(event.value);
                  return;
                }
                answered = true;
                resolve(event.value);
                // The result is all the host waits for, so the frame stops whether or not it ends the resolution itself.
                stop();
              },
              // An end before the result is a failure.
              end: error => {
                if (!answered) {
                  reject(error ?? new Error(PROTOCOL_ERRORS.RESOLUTION_ENDED));
                }
              },
            },
            { signal },
          );
        }),
    );
  }

  return {
    async warmupProtocol(): Promise<void> {
      await rpc.request(protocolSchema.traits.frame.warmup, undefined);
    },
    resolveDotNameRemote: resolveDotName,
    resolveOwnerRemote: (label: string) => rpc.request(owner, { label }),
    resolveExecutableManifestRemote: (label: string, kind: 'app' | 'widget' | 'worker') =>
      rpc.request(executableManifest, { label, kind }),
    resolveRootManifestRemote: (label: string) => rpc.request(rootManifest, { label }),
  };
}
