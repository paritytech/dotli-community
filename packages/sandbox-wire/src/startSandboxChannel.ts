// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The host's one window listener for sandbox traffic. It parses each message once and drops any that a trusted origin
// did not send, so a consumer only ever sees typed messages from a sandbox frame.

import { parseSandboxToHostMessage, type SandboxToHostMessage } from './sandboxMessages.js';

export type SandboxMessageType = SandboxToHostMessage['type'];

export type SandboxMessageOf<T extends SandboxMessageType> = Extract<SandboxToHostMessage, { type: T }>;

/** For a consumer that answers the frame or keeps state per frame. */
export type SandboxSender = {
  /** The frame's origin, already checked as trusted. */
  origin: string;
  /** Null when the frame went away before its message was handled. */
  source: MessageEventSource | null;
};

export type StartedSandboxChannel = ReturnType<typeof startSandboxChannel>;

/** The started channel without `stop`, for a consumer that listens but does not own the channel. */
export type SandboxChannel = Omit<StartedSandboxChannel, 'stop'>;

type Params = {
  /** The window the channel listens on for `message` events. */
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** Decides whether an origin may speak for a sandbox frame. */
  isTrustedOrigin: (origin: string) => boolean;
  /** Hears each sandbox message the channel drops for its origin. */
  onUntrusted?: (type: SandboxMessageType, origin: string) => void;
  /** Hears a handler that threw. Injected, since this package reports nothing itself. */
  report: (error: unknown, type: SandboxMessageType) => void;
};

type AnyHandler = (message: SandboxToHostMessage, sender: SandboxSender) => void;

/**
 * Starts listening to sandbox messages on `target` and returns the channel.
 * The channel hands each trusted, well-formed message to the handlers registered for its type. `stop` removes the
 * window listener and drops every handler, and is safe to call again. It never throws: a handler that throws goes to
 * `report` and the rest still run.
 */
export function startSandboxChannel({ target, isTrustedOrigin, onUntrusted, report }: Params) {
  const handlers = new Map<SandboxMessageType, Set<AnyHandler>>();

  function handleMessage(event: MessageEvent): void {
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
  }

  target.addEventListener('message', handleMessage);

  return {
    /** Hands each trusted message of `type` to `handler` until the returned unsubscribe runs. Never throws. */
    on<T extends SandboxMessageType>(
      type: T,
      handler: (message: SandboxMessageOf<T>, sender: SandboxSender) => void,
    ): () => void {
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
    /** Stops listening to the window and drops every handler. Safe to call again. */
    stop(): void {
      target.removeEventListener('message', handleMessage);
      handlers.clear();
    },
  };
}
