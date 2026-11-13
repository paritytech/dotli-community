// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Whether the transport is open, and the one way out to the peer. It is the one owner of the phase: the handshake
// connects it, and a failed handshake, a failed post or the owner closes it.

import { toError } from '@dotli/shared';
import type { Address } from './defineSchema.js';
import type { IssueReport } from './createIssueReport.js';
import type { FrameBytes } from './frameBytes.js';
import type { Provider } from './provider.js';

/** Whether the transport is still waiting for the handshake, connected to a peer with its hello, or closed. */
type Phase<Hello> = { name: 'connecting' } | { name: 'connected'; peerHello: Hello } | { name: 'closed'; error: Error };

/** The phase, post and close of one transport. */
export type Connection<Hello> = ReturnType<typeof createConnection<Hello>>;

type Params = {
  provider: Provider;
  /** Hands an issue to the owner. Never throws. */
  report: IssueReport['report'];
  /** Ends every call once the transport closes, after the phase says closed. */
  onClose: (error: Error) => void;
};

type PostParams = {
  data: FrameBytes;
  /** The call the bytes belong to, if any, which a failed post names. */
  address?: Address | undefined;
};

type PlaceParams = {
  /** Posts the call once the handshake succeeded. */
  send: () => void;
  /** Hears the error the transport closed with, for a call that never went out. */
  fail: (error: Error) => void;
};

/** The phase of one transport, the post to its provider, and the close that ends it. */
export function createConnection<Hello>({ provider, report, onClose }: Params) {
  let phase: Phase<Hello> = { name: 'connecting' };
  const stopAttempts = new AbortController();
  const handshakeOver = new Promise<void>(resolve => {
    stopAttempts.signal.addEventListener('abort', () => {
      resolve();
    });
  });

  function getPhase(): Phase<Hello> {
    return phase;
  }

  function post({ data, address }: PostParams): boolean {
    if (phase.name === 'closed') {
      return false;
    }
    try {
      provider.postMessage(data);
      return true;
    } catch (thrown) {
      const error = toError(thrown);
      const call = address === undefined ? undefined : { section: address.section, method: address.method };
      report({ kind: 'post_failed', error, call });
      close(error);
      return false;
    }
  }

  function place({ send, fail }: PlaceParams): void {
    void handshakeOver.then(() => {
      if (phase.name === 'closed') {
        fail(phase.error);
      } else {
        send();
      }
    });
  }

  function connect(peerHello: Hello): void {
    if (phase.name !== 'connecting') {
      return;
    }
    phase = { name: 'connected', peerHello };
    stopAttempts.abort();
  }

  function close(error: Error): void {
    if (phase.name === 'closed') {
      return;
    }
    phase = { name: 'closed', error };
    stopAttempts.abort(error);
    onClose(error);
  }

  return {
    /** Whether the transport waits for the handshake, is connected, or is closed, with the error it closed with. */
    getPhase,
    /**
     * Posts bytes, of the call at `address` when they belong to one, and returns whether they went out. A closed
     * transport posts nothing. A post the provider throws on is reported, then closes the transport with the provider's
     * error, as truapi's client does, so every call hears it and the phase holds why. Never throws.
     */
    post,
    /**
     * Runs `send` once the handshake is over, or `fail` with the error the transport closed with. Callbacks on one
     * promise run in the order they were added, so calls go out in call order.
     */
    place,
    /**
     * Connects to the peer whose hello is `peerHello`, while the handshake is still going, and does nothing after. An
     * answer connects the opener in the turn it arrives, so a call the accepter makes right after its answer finds this
     * side open.
     */
    connect,
    /**
     * Closes this side with `error`, once, and posts nothing, as truapi's runtime does on dispose. The phase says
     * closed before `onClose` ends the calls, and calls still waiting for the handshake find the error as they leave.
     */
    close,
    /** Settles once the handshake succeeds or fails, or the transport closes. The phase says which. */
    whenOver: handshakeOver,
    /** Aborts once the handshake is settled or the transport closed, which stops the opener's attempts. */
    stopSignal: stopAttempts.signal,
  };
}
