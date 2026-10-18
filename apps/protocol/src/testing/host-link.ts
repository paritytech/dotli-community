// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A host page linked to this frame's transport over a real port pair, so specs drive the frame's handlers through the
// wire as the host does.

import { protocolSchema, type ProtocolSchema, type ProtocolTransport } from '@dotli/protocol';
import {
  createPortProvider,
  createTransport,
  type CallError,
  type DomainError,
  type MethodTypes,
  type Result,
  type SubscriptionMethodName,
  type TraitName,
  type TransportIssue,
} from '@dotli/transport';

export const HOST_ORIGIN = 'http://host-playground.localhost:5173';
export const PRODUCT_ORIGIN = 'http://bafy.app.localhost:5173';

type S = ProtocolSchema;

/** What a subscription of `method` in `trait` starts with. */
export type StartOf<T extends TraitName<S>, M extends SubscriptionMethodName<S, T>> =
  MethodTypes<S, T, M> extends { start: infer St } ? St : never;

/** What a subscription of `method` in `trait` sends. */
export type ValueOf<T extends TraitName<S>, M extends SubscriptionMethodName<S, T>> =
  MethodTypes<S, T, M> extends { receive: infer V } ? V : never;

/** How a subscription of `method` in `trait` ended: the peer's interrupt, or the error its transport closed with. */
export type EndOf<T extends TraitName<S>, M extends SubscriptionMethodName<S, T>> =
  Result<void, CallError<DomainError<S, T, M>>> | Error;

export interface HostLink {
  /** The frame's end, where a spec registers the handlers under test. */
  serving: ProtocolTransport;
  /** The host page's end, which opens the handshake. */
  host: ProtocolTransport;
  /** What either end could not handle itself, in order. */
  issues: TransportIssue[];
  /** Disposes both ends and closes the ports. */
  close: () => void;
}

const links = new Set<HostLink>();

/**
 * Links a host page known by `origin`. A port has no origin, so the frame's provider names it, as the window provider
 * names the admitted parent's.
 */
export function linkHost(origin: string | null = HOST_ORIGIN): HostLink {
  const channel = new MessageChannel();
  const issues: TransportIssue[] = [];
  const onIssue = (issue: TransportIssue): void => {
    issues.push(issue);
  };
  const frameEnd = createPortProvider(channel.port1);
  const serving = createTransport(
    protocolSchema,
    { ...frameEnd, peerOrigin: () => origin },
    { handshake: 'accept', hello: { resolutionId: null }, onIssue },
  );
  const host = createTransport(protocolSchema, createPortProvider(channel.port2), {
    handshake: 'open',
    hello: { resolutionId: null },
    onIssue,
  });
  host.connect();
  const link: HostLink = {
    serving,
    host,
    issues,
    close: () => {
      links.delete(link);
      const over = new Error('The spec is over');
      host.dispose(over);
      serving.dispose(over);
    },
  };
  links.add(link);
  return link;
}

/** Closes every link a spec left open, so no port keeps the test run alive. */
export function closeHostLinks(): void {
  for (const link of [...links]) {
    link.close();
  }
}

export interface Recording<T extends TraitName<S>, M extends SubscriptionMethodName<S, T>> {
  events: ValueOf<T, M>[];
  /** Settles with the end: the frame's interrupt, or the error the transport closed with. */
  ended: Promise<EndOf<T, M>>;
  /** Resolves once `count` events have arrived. */
  until: (count: number) => Promise<void>;
  unsubscribe: () => void;
}

/** Subscribes on `transport` and records every value and the end. */
export function record<T extends TraitName<S>, M extends SubscriptionMethodName<S, T>>(
  transport: ProtocolTransport,
  trait: T,
  method: M,
  start: StartOf<T, M>,
): Recording<T, M> {
  const events: ValueOf<T, M>[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  let end: (outcome: EndOf<T, M>) => void = () => undefined;
  const ended = new Promise<EndOf<T, M>>(resolve => {
    end = resolve;
  });
  const handle = transport.subscribe(trait, method, start, {
    receive: value => {
      events.push(value);
      for (const waiter of [...waiters]) {
        if (events.length >= waiter.count) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    },
    interrupt: end,
  });
  handle.onClose(end);
  return {
    events,
    ended,
    until: count =>
      events.length >= count
        ? Promise.resolve()
        : new Promise(resolve => {
            waiters.push({ count, resolve });
          }),
    unsubscribe: () => {
      handle.stop();
    },
  };
}
