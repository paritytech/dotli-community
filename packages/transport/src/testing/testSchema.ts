// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The schema most specs run on, and the method fixtures that cover each shape of method.

import { Result, _void, str } from 'scale-ts';
import { callError } from '../callError.js';
import { defineSchema } from '../defineSchema.js';
import { request } from '../request.js';
import { toMessageBytes } from '../messageBytes.js';
import { subscription } from '../subscription.js';
import { VERSION } from './constants.js';
import { word } from './word.js';

export const testSchema = defineSchema({
  version: VERSION,
  hello: str,
  sections: {
    notes: {
      read: request({ request: word, response: str, error: str }),
      touch: request({ request: _void, response: _void }),
      // Its author ends it with a `Result`: `Ok` a clean end, `Err` with why.
      watch: subscription({ start: word, receive: word, interrupt: Result(_void, str) }),
    },
    echo: {
      say: request({ request: str, response: str }),
      listen: subscription({ start: _void, receive: str }),
      // An interrupt of truapi's layout, so a relay can pass a failure it heard on as the method's own reason.
      relay: subscription({ start: word, receive: word, interrupt: Result(_void, callError(str)) }),
    },
  },
});

export const { notes, echo } = testSchema.sections;

/** The wire id of the `notes` section, for a test that calls a method the section lacks. */
export const NOTES = testSchema.addressOf(notes.read).sectionId;

/** A subscription's stop followed by a byte it leaves unread, so a whole decode refuses it. */
export const TRAILED_STOP = toMessageBytes(
  Uint8Array.of(...notes.watch.message.enc({ tag: 'stop', value: undefined }), 0),
);
