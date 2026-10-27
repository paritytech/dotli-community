// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The numbering of this side's calls. */
export type CallIds = ReturnType<typeof createCallIds>;

type Params = {
  /** Whether this side opens the handshake, and so numbers its calls odd. The accepter numbers its calls even. */
  opens: boolean;
};

// The largest id the wire's u32 carries. Ids wrap long after any call with an old one has settled.
const MAX_ID = 0xffff_ffff;

/** The numbering of this side's calls, so a frame's id tells whose call it is about. */
export function createCallIds({ opens }: Params) {
  const firstId = opens ? 1 : 2;
  let lastId = firstId - 2;

  function takeNext(): number {
    lastId = lastId + 2 > MAX_ID ? firstId : lastId + 2;
    return lastId;
  }

  function isOwn(id: number): boolean {
    return id % 2 === firstId % 2;
  }

  return {
    /** The id of this side's next call, wrapping to the first once the wire's u32 runs out. */
    takeNext,
    /** Whether call `id` is one this side made. */
    isOwn,
  };
}
