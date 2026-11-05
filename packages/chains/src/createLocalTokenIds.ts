// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The broker's numbering of the local tokens its sessions see. */
export type LocalTokenIds = ReturnType<typeof createLocalTokenIds>;

type TakeNextParams = {
  /** The session the token is for. */
  sessionId: string;
};

/**
 * The broker's local tokens, numbered by one counter that nothing resets, so no two tokens of a broker's life are ever
 * the same. Sessions see these tokens on the wire.
 */
export function createLocalTokenIds() {
  let counter = 0;

  function takeNext({ sessionId }: TakeNextParams): string {
    const token = `token:${counter.toString(36)}:${sessionId}`;
    counter += 1;
    return token;
  }

  return {
    /** A token no earlier call returned, as `token:<counter in base 36>:<sessionId>`. */
    takeNext,
  };
}
