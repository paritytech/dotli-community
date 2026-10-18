// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A host page linked to this frame's transport over a real port pair, so specs drive the frame's handlers through the
// wire as the host does. Every issue a transport of the link raises is kept, and closing the links fails on any issue a
// spec did not take, so none goes unseen.

import { protocolSchema, type ProtocolTransport } from '@dotli/protocol';
import {
  createPortProvider,
  createTransport,
  type CallError,
  type ResultPayload,
  type Subscription,
  type TransportIssue,
} from '@dotli/transport';

export const HOST_ORIGIN = 'http://host-playground.localhost:5173';
export const PRODUCT_ORIGIN = 'http://bafy.app.localhost:5173';

/** How a subscription whose own end reason is `I` ended: the peer's interrupt, or the error its transport closed with. */
export type EndOf<I> = ResultPayload<undefined, CallError<I>> | Error;

export interface HostLink {
  /** The frame's end, where a spec registers the handlers under test. */
  serving: ProtocolTransport;
  /** The host page's end, which opens the handshake. */
  host: ProtocolTransport;
  /**
   * What either end, or a transport the spec handed `report`, could not handle itself, in order. A spec that expects an
   * issue takes it from here, and any left fails the spec as its links close.
   */
  issues: TransportIssue[];
  /** The issue hook of the link, for another transport of the spec. */
  report: (issue: TransportIssue) => void;
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
    report: onIssue,
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

function describeIssue(issue: TransportIssue): string {
  switch (issue.kind) {
    case 'refused':
      return `refused as ${issue.reason}, ${issue.cause.message}`;
    case 'post_failed':
      return `a post failed, ${issue.error.message}`;
    case 'listener_threw':
      return `a listener threw, ${issue.error.message}`;
  }
}

/**
 * Closes every link a spec left open, so no port keeps the test run alive, and throws when a link kept an issue the
 * spec did not take.
 */
export function closeHostLinks(): void {
  const unseen = [...links].flatMap(link => link.issues.splice(0));
  for (const link of [...links]) {
    link.close();
  }
  if (unseen.length > 0) {
    throw new Error(`The links raised issues the spec did not expect: ${unseen.map(describeIssue).join(' | ')}`, {
      cause: unseen,
    });
  }
}

export interface Recording<V, I> {
  events: V[];
  /** Settles with the end: the frame's interrupt, or the error the transport closed with. */
  ended: Promise<EndOf<I>>;
  /** Resolves once `count` events have arrived. */
  until: (count: number) => Promise<void>;
  unsubscribe: () => void;
}

/** Subscribes on `transport` and records every value and the end. */
export function record<S, V, I>(
  transport: ProtocolTransport,
  method: Subscription<S, V, I>,
  start: NoInfer<S>,
): Recording<V, I> {
  const events: V[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  let end: (outcome: EndOf<I>) => void = () => undefined;
  const ended = new Promise<EndOf<I>>(resolve => {
    end = resolve;
  });
  const handle = transport.subscribe(method, start, {
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
