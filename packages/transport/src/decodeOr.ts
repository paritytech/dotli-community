// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { toError } from '@dotli/shared';

type Params<Decoded> = {
  decoder: (data: Uint8Array) => Decoded;
  data: Uint8Array;
  /** Hears why `data` does not decode, as an `Error`. */
  onError: (error: Error) => void;
};

/**
 * Decodes `data`, or hands `onError` why it does not and gives undefined. Never throws unless `onError` does. A decoder
 * whose value may itself be undefined needs a `try` at its site instead, since undefined would not tell the two apart.
 *
 * @example
 * const frame = decodeOr({ decoder: frameCodec.dec, data, onError: error => refuse('malformed', error) });
 */
export function decodeOr<Decoded>({ decoder, data, onError }: Params<Decoded>): Decoded | undefined {
  try {
    return decoder(data);
  } catch (error) {
    onError(toError(error));
    return undefined;
  }
}
