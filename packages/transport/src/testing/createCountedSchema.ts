// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A schema for tests of which side decodes a payload.

import { Result, _void, enhanceCodec, str, type Codec } from 'scale-ts';
import { defineSchema } from '../defineSchema.js';
import { request } from '../request.js';
import { subscription } from '../subscription.js';
import { VERSION } from './constants.js';
import { echo, notes } from './testSchema.js';
import { word } from './word.js';

/**
 * `testSchema` with a `notes.read` and a `notes.watch` whose payloads count their decodes, so a test can tell which
 * side read a payload. The counted payloads are the request, the response, the start and the values.
 */
export function createCountedSchema() {
  let decodes = 0;
  const schema = defineSchema({
    version: VERSION,
    hello: str,
    sections: {
      notes: {
        ...notes,
        read: request({ request: countDecodes(word), response: countDecodes(str), error: str }),
        watch: subscription({ start: countDecodes(word), receive: countDecodes(word), interrupt: Result(_void, str) }),
      },
      echo,
    },
  });
  return { schema, getDecodeCount: () => decodes };

  function countDecodes<Value>(codec: Codec<Value>): Codec<Value> {
    return enhanceCodec(
      codec,
      (value: Value) => value,
      (value: Value) => {
        decodes += 1;
        return value;
      },
    );
  }
}
