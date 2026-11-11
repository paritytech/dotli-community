// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { protocolSchema } from '@dotli/protocol';
import { ok } from '@dotli/transport';
import { serveHeartbeat } from './serveHeartbeat.js';
import { closeHostLinks, linkHost } from './testing/linkHost.js';

afterEach(closeHostLinks);

const { frame } = protocolSchema.sections;

describe('serving the heartbeat', () => {
  it('As the host, I send the frame a heartbeat and it answers ok', async () => {
    // Given a heartbeat served to a host
    const { serving, host } = linkHost();
    serveHeartbeat({ serving });

    // When the host sends a heartbeat
    const answer = await host.request(frame.heartbeat, undefined);

    // Then the frame answers ok
    expect(answer).toEqual(ok());
  });
});
