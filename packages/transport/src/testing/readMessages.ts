// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { fromHex } from '@dotli/shared';
import type { Codec } from 'scale-ts';
import type { Schema, Sections } from '../defineSchema.js';
import type { AnyMethod } from '../method.js';
import type { RecordedWireMessage } from './recordMessage.js';

type Params<Hello, T extends Sections, Message> = {
  /** The schema the recording was made with. */
  schema: Schema<Hello, T>;
  /** The method whose messages are read, as the schema holds it. */
  method: AnyMethod & { readonly message: Codec<Message> };
  /** The recording, with the messages of every method. */
  recorded: readonly RecordedWireMessage[];
};

/** Reads the recorded messages of `method`, decoded with it. */
export function readMessages<Hello, T extends Sections, Message>({
  schema,
  method,
  recorded,
}: Params<Hello, T, Message>): Message[] {
  const address = schema.addressOf(method);
  // Read as the method's own codec, so the messages come back typed by it.
  const codec: Codec<Message> = method.message;
  return recorded
    .filter(message => message.section === address.section && message.method === address.method)
    .map(message => codec.dec(fromHex(message.message)));
}
