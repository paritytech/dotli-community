// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { ProtocolFatalError, ProtocolInitFailedError } from '@dotli/protocol';
import { createFrameStatus } from './frame-status.js';
import { closeHostLinks, linkHost, record } from './testing/host-link.js';

afterEach(closeHostLinks);

function setup(): { status: ReturnType<typeof createFrameStatus>; link: ReturnType<typeof linkHost> } {
  const status = createFrameStatus();
  const link = linkHost();
  link.serving.handleSubscription('frameStatus', status.handler);
  return { status, link };
}

describe('the frame status', () => {
  it('As the host, I subscribe after my frame failed and hear the failure at once', async () => {
    // Given
    const { status, link } = setup();
    status.fail(new ProtocolInitFailedError('Unknown protocol mode: "nope"'));

    // When
    const heard = record(link.host, 'frameStatus', undefined);

    // Then
    const error = await heard.ended;
    expect(error).toMatchObject({ name: 'ProtocolInitFailedError', message: 'Unknown protocol mode: "nope"' });
    expect(heard.events).toEqual([]);
  });

  it('As the host, I subscribe after my frame became ready and hear ready at once', async () => {
    // Given
    const { status, link } = setup();
    status.ready();

    // When
    const heard = record(link.host, 'frameStatus', undefined);

    // Then
    await heard.until(1);
    expect(heard.events).toHaveLength(1);
  });

  it('As the host, I wait while my frame boots and hear ready once it is', async () => {
    // Given
    const { status, link } = setup();
    const heard = record(link.host, 'frameStatus', undefined);
    await link.host.whenConnected();

    // When
    status.ready();
    status.ready();

    // Then
    await heard.until(1);
    expect(heard.events).toHaveLength(1);
  });

  it('As the host, my frame whose light client dies after ready ends my status with the fatal, and a later failure is not heard', async () => {
    // Given
    const { status, link } = setup();
    status.ready();
    const heard = record(link.host, 'frameStatus', undefined);
    await heard.until(1);

    // When
    status.fail(new ProtocolFatalError('Light client died'));
    status.fail(new ProtocolInitFailedError('too late'));
    status.ready();

    // Then
    expect(await heard.ended).toMatchObject({ name: 'ProtocolFatalError', message: 'Light client died' });
    const late = record(link.host, 'frameStatus', undefined);
    expect(await late.ended).toMatchObject({ name: 'ProtocolFatalError' });
  });
});
