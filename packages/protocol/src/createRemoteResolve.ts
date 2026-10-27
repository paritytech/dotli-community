// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Name and manifest resolution done by the protocol frame's light client.

import type { ResolvePhase } from '@dotli/resolver';

import type { FrameRpc } from './createFrameRpc.js';
import { PROTOCOL_ERRORS } from './errors.js';
import { protocolSchema } from './schema.js';
import { subscribe } from './subscribe.js';

type Params = {
  rpc: FrameRpc;
};

const { dotName, owner, executableManifest, rootManifest } = protocolSchema.sections.resolve;

/** Name and manifest resolution in the frame, each request on `rpc`. */
export function createRemoteResolve({ rpc }: Params) {
  function resolveDotName(label: string, onPhase?: (phase: ResolvePhase) => void): Promise<string | null> {
    return rpc.call(
      dotName,
      (transport, signal) =>
        new Promise<string | null>((resolve, reject) => {
          const unsubscribe = subscribe({
            transport,
            method: dotName,
            start: { label },
            listeners: {
              receive: event => {
                if (event.tag === 'phase') {
                  onPhase?.(event.value);
                  return;
                }
                resolve(event.value);
                // The result is all the host waits for, so the frame stops whether or not it ends the resolution itself.
                unsubscribe();
              },
              // An end before the result is a failure. One after it leaves the settled promise as it is.
              end: error => {
                reject(error ?? new Error(PROTOCOL_ERRORS.RESOLUTION_ENDED));
              },
            },
            signal,
          });
        }),
    );
  }

  return {
    /**
     * Asks the frame to warm its light client up, and resolves on its answer. Rejects with a `ProtocolRequestError`
     * named after why the frame failed the call, or a `ProtocolRequestError` named `ProtocolTimeoutError` once its
     * budget runs out, or with the error the frame went down with, such as a `ProtocolFatalError` or an `Error` with a
     * `PROTOCOL_ERRORS` text.
     */
    async warmup(): Promise<void> {
      await rpc.request(protocolSchema.sections.frame.warmup, undefined);
    },
    /**
     * Resolves `label`'s content id, or null for a name with none, after `onPhase` hears each resolve phase. The
     * resolution is unsubscribed on its result. The budget runs once the frame is ready, and a resolution that outlives
     * it is unsubscribed, so the frame stops it. Rejects with a `ProtocolRequestError` named `NetworkSyncTimeoutError`
     * or `ApiStoppedError` for a resolver failure, and with one named after why the frame failed the resolution for any
     * other failure. Rejects with a `ProtocolRequestError` named `ProtocolTimeoutError` once its budget runs out.
     * Rejects with an `Error` of the `RESOLUTION_ENDED` text when the frame ends the resolution before its result.
     * Rejects with the error the frame went down with, such as a `ProtocolFatalError` or an `Error` with a
     * `PROTOCOL_ERRORS` text.
     */
    resolveDotName,
    /**
     * Resolves `label`'s owner address, or null for a name with none. Rejects with a `ProtocolRequestError` named
     * `NetworkSyncTimeoutError` or `ApiStoppedError` for a resolver failure, and with one named after why the frame
     * failed the call for any other failure. Rejects with a `ProtocolRequestError` named `ProtocolTimeoutError` once
     * its budget runs out. Rejects with the error the frame went down with, such as a `ProtocolFatalError` or an
     * `Error` with a `PROTOCOL_ERRORS` text.
     */
    resolveOwner: (label: string) => rpc.request(owner, { label }),
    /**
     * Resolves the manifest result of `label`'s executable of `kind`. Rejects with a `ProtocolRequestError` named
     * `NetworkSyncTimeoutError` or `ApiStoppedError` for a resolver failure, and with one named after why the frame
     * failed the call for any other failure. Rejects with a `ProtocolRequestError` named `ProtocolTimeoutError` once
     * its budget runs out. Rejects with the error the frame went down with, such as a `ProtocolFatalError` or an
     * `Error` with a `PROTOCOL_ERRORS` text.
     */
    resolveExecutableManifest: (label: string, kind: 'app' | 'widget' | 'worker') =>
      rpc.request(executableManifest, { label, kind }),
    /**
     * Resolves the manifest result of `label`'s root manifest. Rejects with a `ProtocolRequestError` named
     * `NetworkSyncTimeoutError` or `ApiStoppedError` for a resolver failure, and with one named after why the frame
     * failed the call for any other failure. Rejects with a `ProtocolRequestError` named `ProtocolTimeoutError` once
     * its budget runs out. Rejects with the error the frame went down with, such as a `ProtocolFatalError` or an
     * `Error` with a `PROTOCOL_ERRORS` text.
     */
    resolveRootManifest: (label: string) => rpc.request(rootManifest, { label }),
  };
}
