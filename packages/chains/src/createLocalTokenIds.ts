// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The broker's numbering of the local tokens its sessions see. */
export type LocalTokenIds = ReturnType<typeof createLocalTokenIds>;

type TakeNextParams = {
  /** What the token names: a subscription a session owns, or its place on a shared follow. */
  prefix: 'token' | 'follow';
  /** The session the token is for. */
  sessionId: string;
};

/**
 * The broker's local tokens, numbered by one counter that both kinds share and nothing resets, so no two tokens of a
 * broker's life are ever the same. Sessions see these tokens on the wire.
 */
export function createLocalTokenIds() {
  let counter = 0;

  function takeNext({ prefix, sessionId }: TakeNextParams): string {
    const token = `${prefix}:${counter.toString(36)}:${sessionId}`;
    counter += 1;
    return token;
  }

  return {
    /** A token no earlier call returned, as `<prefix>:<counter in base 36>:<sessionId>`. */
    takeNext,
  };
}
