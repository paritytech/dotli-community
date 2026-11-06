// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { protocolSchema } from '@dotli/protocol';
import { err, ok, unsupported } from '@dotli/transport';
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

  it("As a frame that stopped serving the heartbeat, I refuse the host's heartbeat as unsupported", async () => {
    // Given a heartbeat served to a host
    const { serving, host } = linkHost();
    const stop = serveHeartbeat({ serving });

    // When the frame stops serving it and the host sends a heartbeat anyway
    stop();
    const refused = await host.request(frame.heartbeat, undefined);

    // Then the host is refused as unsupported
    expect(refused).toEqual(err(unsupported()));
  });
});
