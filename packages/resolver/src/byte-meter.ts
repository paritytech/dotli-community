// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Counts the light client's inbound bytes at the socket constructors, since resource timing misses
// WebSocket and WebRTC. Install before smoldot starts, or its earlier connections go uncounted.

let received = 0;
let installed = false;

export function chainBytesReceived(): number {
  return received;
}

function sizeOf(data: unknown): number {
  if (typeof data === 'string') {
    // UTF-8 is what crossed the wire, not UTF-16 code units.
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

/** Idempotent. Adds listeners rather than replacing `onmessage`, so smoldot's own handler stays. */
export function installByteMeter(): void {
  if (installed || typeof window === 'undefined') {
    return;
  }
  installed = true;

  // A subclass keeps the construct signature, statics and prototype that `new WebSocket()` callers need.
  class MeteredWebSocket extends window.WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('message', (event: MessageEvent) => {
        received += sizeOf(event.data);
      });
    }
  }
  window.WebSocket = MeteredWebSocket;

  // webrtc-direct bootnodes carry a real share of the sync where a network publishes them.
  if (typeof RTCPeerConnection !== 'undefined') {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with the original `this`.
    const nativeCreate = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (
      this: RTCPeerConnection,
      label: string,
      options?: RTCDataChannelInit,
    ): RTCDataChannel {
      const channel = nativeCreate.call(this, label, options);
      channel.addEventListener('message', (event: MessageEvent) => {
        received += sizeOf(event.data);
      });
      return channel;
    };
  }
}
