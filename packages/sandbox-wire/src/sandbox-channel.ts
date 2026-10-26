// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host's one window listener for sandbox traffic. It parses each message once and drops any that a trusted origin
// did not send, so a consumer only ever sees typed messages from a sandbox frame.

import { parseSandboxToHostMessage, type SandboxToHostMessage } from './sandbox-messages.js';

export type SandboxMessageType = SandboxToHostMessage['type'];

export type SandboxMessageOf<T extends SandboxMessageType> = Extract<SandboxToHostMessage, { type: T }>;

/** For a consumer that answers the frame or keeps state per frame. */
export type SandboxSender = {
  origin: string;
  /** Null when the frame went away before its message was handled. */
  source: MessageEventSource | null;
};

export type SandboxChannel = {
  /** Returns the unsubscribe. */
  on<T extends SandboxMessageType>(
    type: T,
    handler: (message: SandboxMessageOf<T>, sender: SandboxSender) => void,
  ): () => void;
};

export type SandboxChannelOptions = {
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  isTrustedOrigin: (origin: string) => boolean;
  /** Hears each sandbox message the channel drops for its origin. */
  onUntrusted?: (type: SandboxMessageType, origin: string) => void;
  /** Hears a handler that threw. Injected, since this package reports nothing itself. */
  report: (error: unknown, type: SandboxMessageType) => void;
};

export type StartedSandboxChannel = {
  stop(): void;
} & SandboxChannel;

type AnyHandler = (message: SandboxToHostMessage, sender: SandboxSender) => void;

export function startSandboxChannel({
  target,
  isTrustedOrigin,
  onUntrusted,
  report,
}: SandboxChannelOptions): StartedSandboxChannel {
  const handlers = new Map<SandboxMessageType, Set<AnyHandler>>();

  const onMessage = (event: MessageEvent): void => {
    // The parse is a cheap shape check that comes first, since this listener sees all postMessage traffic.
    const message = parseSandboxToHostMessage(event.data);
    if (message === null) {
      return;
    }
    if (!isTrustedOrigin(event.origin)) {
      onUntrusted?.(message.type, event.origin);
      return;
    }
    const sender: SandboxSender = { origin: event.origin, source: event.source };
    // A snapshot, so a handler that unsubscribes does not skip the next one. Each runs on its own, so one that throws
    // does not keep the message from the rest.
    for (const handler of [...(handlers.get(message.type) ?? [])]) {
      try {
        handler(message, sender);
      } catch (error) {
        report(error, message.type);
      }
    }
  };
  target.addEventListener('message', onMessage);

  return {
    on(type, handler) {
      let forType = handlers.get(type);
      if (forType === undefined) {
        forType = new Set();
        handlers.set(type, forType);
      }
      // Keyed by type, so the handler only ever receives its own message type.
      const stored = handler as AnyHandler;
      forType.add(stored);
      return () => {
        forType.delete(stored);
      };
    },
    stop() {
      target.removeEventListener('message', onMessage);
      handlers.clear();
    },
  };
}
