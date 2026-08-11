// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Count every byte the light client pulls off the network.
 *
 * The loading screen reports a download speed, and the only figure available
 * to it used to be the app archive coming over bitswap. That is the last step
 * of a load; for the seconds before it the chain sync is doing all the work
 * and the readout sat at zero.
 *
 * smoldot opens its own sockets from inside its own JS, so there is no
 * handle to ask. Resource timing does not cover WebSocket or WebRTC either.
 * The one place the bytes are visible is the constructor, so this wraps the
 * two transports smoldot uses and tallies what arrives. Install it before
 * smoldot starts or its already-open connections go uncounted.
 */

let received = 0;
let installed = false;

/** Total bytes received over the light client's transports so far. */
export function chainBytesReceived(): number {
  return received;
}

function sizeOf(data: unknown): number {
  if (typeof data === "string") {
    // Frames are binary in practice; a text frame is counted as UTF-8 rather
    // than as UTF-16 code units, which is what actually crossed the wire.
    return new TextEncoder().encode(data).length;
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  if (data instanceof Blob) {
    return data.size;
  }
  return 0;
}

/**
 * Wrap `WebSocket` and `RTCDataChannel` so their inbound frames are tallied.
 *
 * Idempotent, and a no-op outside a browser. Listeners are added rather than
 * replacing `onmessage`, so smoldot's own handler is untouched.
 */
export function installByteMeter(): void {
  if (installed || typeof window === "undefined") {
    return;
  }
  installed = true;

  // Subclassing rather than wrapping in a plain function: `WebSocket` is a
  // real class, so a caller doing `new WebSocket(...)` needs a construct
  // signature, and the statics and prototype come along for free.
  class MeteredWebSocket extends window.WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", (event: MessageEvent) => {
        received += sizeOf(event.data);
      });
    }
  }
  window.WebSocket = MeteredWebSocket;

  // webrtc-direct bootnodes carry a real share of the sync on networks that
  // publish them, so the data channels are counted the same way.
  if (typeof RTCPeerConnection !== "undefined") {
    // Taken off the prototype only to call it back with the original `this`.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const nativeCreate = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (
      this: RTCPeerConnection,
      label: string,
      options?: RTCDataChannelInit,
    ): RTCDataChannel {
      const channel = nativeCreate.call(this, label, options);
      channel.addEventListener("message", (event: MessageEvent) => {
        received += sizeOf(event.data);
      });
      return channel;
    };
  }
}
