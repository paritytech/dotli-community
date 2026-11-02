// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The vault schema.

import { Bytes, Struct, _void, str, u128 } from 'scale-ts';
import { defineSchema } from '../defineSchema.js';
import { request } from '../request.js';
import { subscription } from '../subscription.js';

/** A schema whose messages carry bytes and a big integer, which JSON does not keep as they are. */
export const vaultSchema = defineSchema({
  version: 1,
  hello: str,
  sections: {
    vault: {
      save: request({ request: Struct({ entropy: Bytes(), amount: u128 }), response: _void }),
      events: subscription({ start: _void, receive: str }),
    },
  },
});
