// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A host page linked to this frame's transport over an in-memory pair, so specs drive the frame's handlers through the
// wire as the host does. Every issue a transport of the link raises is kept, and closing the links fails on any of
// them, so none goes unseen.

import { protocolSchema } from '@dotli/protocol';
import { createProviderPair } from '@dotli/transport/testing';
import { createTransport, describeIssue, type TransportIssue } from '@dotli/transport';

/** A host page linked to the frame. */
export type HostLink = ReturnType<typeof linkHost>;

/** Each open link, with what either end could not handle itself, in order. */
const links = new Map<HostLink, TransportIssue[]>();

/** Links a host page to the frame. */
export function linkHost() {
  const { left, right, delivered } = createProviderPair();
  const issues: TransportIssue[] = [];
  const serving = createTransport({
    schema: protocolSchema,
    provider: right,
    handshake: 'respond',
    hello: { resolutionId: null },
    onIssue: keepIssue,
  });
  const host = createTransport({
    schema: protocolSchema,
    provider: left,
    handshake: 'offer',
    hello: { resolutionId: null },
    onIssue: keepIssue,
  });
  host.connect();

  const link = {
    /** The frame's end, where a spec registers the handlers under test. */
    serving,
    /** The host page's end, which opens the handshake. */
    host,
    /** Every frame either end delivered to the other, in order. */
    delivered,
    /** Disposes both ends, so every pending call on either rejects. May run more than once. Never throws. */
    dispose,
  };
  links.set(link, issues);
  return link;

  function keepIssue(issue: TransportIssue): void {
    issues.push(issue);
  }

  function dispose(): void {
    links.delete(link);
    const over = new Error('The spec is over');
    host.dispose(over);
    serving.dispose(over);
  }
}

/** Closes every link a spec left open, and throws when a link raised an issue. */
export function closeHostLinks(): void {
  const unseen = [...links.values()].flat();
  for (const link of [...links.keys()]) {
    link.dispose();
  }
  if (unseen.length > 0) {
    throw new Error(`The links raised issues the spec did not expect: ${unseen.map(describeIssue).join(' | ')}`, {
      cause: unseen,
    });
  }
}
