// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A text codec that refuses the empty string.

import { enhanceCodec, str } from 'scale-ts';

/** Text that is never empty, so a test can make a payload that does not encode. */
export const word = enhanceCodec(
  str,
  (value: string) => {
    if (value === '') {
      throw new RangeError('A word is never empty');
    }
    return value;
  },
  (value: string) => value,
);
