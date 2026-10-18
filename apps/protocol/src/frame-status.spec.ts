// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import {
  ProtocolFatalError,
  ProtocolInitFailedError,
  ProtocolPortReleasedError,
  type FrameFailure,
} from '@dotli/protocol';
import { domain, err, hostFailure, ok, type CallError } from '@dotli/transport';
import { createFrameStatus, type FrameStatusSink } from './frame-status.js';
import { closeHostLinks, linkHost, record } from './testing/host-link.js';

afterEach(closeHostLinks);

function setup(): { status: ReturnType<typeof createFrameStatus>; link: ReturnType<typeof linkHost> } {
  const status = createFrameStatus();
  const link = linkHost();
  link.serving.handleSubscription('frame', 'status', status.handler);
  return { status, link };
}

const context = { origin: null, hello: { resolutionId: null } };

describe('the frame status', () => {
  it('As the host, I subscribe after my frame failed and hear the failure at once', async () => {
    // Given
    const { status, link } = setup();
    status.fail(new ProtocolInitFailedError('Unknown protocol mode: "nope"'));

    // When
    const heard = record(link.host, 'frame', 'status', undefined);

    // Then
    expect(await heard.ended).toEqual(err(domain({ tag: 'initFailed', value: 'Unknown protocol mode: "nope"' })));
    expect(heard.events).toEqual([]);
  });

  it('As the host, I subscribe after my frame became ready and hear ready at once', async () => {
    // Given
    const { status, link } = setup();
    status.ready();

    // When
    const heard = record(link.host, 'frame', 'status', undefined);

    // Then
    await heard.until(1);
    expect(heard.events).toHaveLength(1);
  });

  it('As the host, I wait while my frame boots and hear ready once it is', async () => {
    // Given
    const { status, link } = setup();
    const heard = record(link.host, 'frame', 'status', undefined);
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
    const heard = record(link.host, 'frame', 'status', undefined);
    await heard.until(1);

    // When
    status.fail(new ProtocolFatalError('Light client died'));
    status.fail(new ProtocolInitFailedError('too late'));
    status.interrupt();
    status.ready();

    // Then
    const fatal = err(domain({ tag: 'fatal', value: 'Light client died' }));
    expect(await heard.ended).toEqual(fatal);
    const late = record(link.host, 'frame', 'status', undefined);
    expect(await late.ended).toEqual(fatal);
  });

  it('As the host, I hear a released port, a failure of no protocol kind and a clean end each as the frame told it', async () => {
    // Given three frames
    const [released, broken, stopped] = [setup(), setup(), setup()];

    // When the first fails with a released port, the second with an error of no protocol kind, and the third ends
    released.status.fail(new ProtocolPortReleasedError('The worker released this tab'));
    broken.status.fail(new TypeError('boot broke'));
    stopped.status.interrupt();

    // Then a protocol failure keeps its type, any other its name, and a clean end is clean
    const failed = [released, broken].map(({ link }) => record(link.host, 'frame', 'status', undefined).ended);
    const clean = record(stopped.link.host, 'frame', 'status', undefined).ended;
    expect(await Promise.all(failed)).toEqual([
      err(domain({ tag: 'released', value: 'The worker released this tab' })),
      err(hostFailure('TypeError: boot broke')),
    ]);
    expect(await clean).toEqual(ok());
  });

  it("As a relay, I end the status with another frame's end as it is", async () => {
    // Given
    const { status, link } = setup();
    const heard = record(link.host, 'frame', 'status', undefined);
    await link.host.whenConnected();
    const workerEnd: CallError<FrameFailure> = hostFailure('ProtocolRequestError: the worker gave up');

    // When
    status.interrupt(workerEnd);

    // Then
    expect(await heard.ended).toEqual(err(workerEnd));
  });

  it('As one of two hosts, I hear my frame fail even when the other host cannot be told, and the failure is reported', () => {
    // Given a status whose first host cannot be told anything
    const reported: unknown[] = [];
    const status = createFrameStatus(error => reported.push(error));
    const broken = new Error('port is gone');
    const ends: (CallError<FrameFailure> | undefined)[] = [];
    const throwing: FrameStatusSink = {
      receive: () => {
        throw broken;
      },
      interrupt: () => {
        throw broken;
      },
    };
    status.handler(undefined, context, throwing);
    status.handler(undefined, context, { receive: () => undefined, interrupt: error => ends.push(error) });

    // When
    status.ready();
    status.fail(new ProtocolFatalError('Light client died'));

    // Then the second host hears the end, and each throw is reported
    expect(ends).toEqual([domain({ tag: 'fatal', value: 'Light client died' })]);
    expect(reported).toEqual([broken, broken]);
  });
});
