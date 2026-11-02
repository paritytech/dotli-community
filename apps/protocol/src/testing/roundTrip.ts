// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { protocolSchema } from '@dotli/protocol';

import type { HostLink } from './linkHost.js';

/** Settles once the frame has answered a call made after everything before it, by asking for a method it lacks. */
export async function roundTrip(link: HostLink): Promise<void> {
  const answer = await link.host.request(protocolSchema.sections.frame.warmup, undefined);
  if (answer.success || answer.value.tag !== 'Unsupported') {
    throw new Error('The frame served the warmup, so the round trip proves nothing');
  }
}
