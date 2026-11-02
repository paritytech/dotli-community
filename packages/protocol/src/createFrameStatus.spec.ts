// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { domain, err, hostFailure, ok } from '@dotli/transport';
import { ProtocolFatalError, ProtocolInitFailedError, ProtocolPortReleasedError } from './errors.js';
import { createFrameStatus, type FrameStatus, type FrameStatusEnd } from './createFrameStatus.js';

const context = { origin: null, hello: { resolutionId: null } };

/** A host subscribed to `status`, recording how many times it heard ready and each end. */
function subscribe(status: FrameStatus): { readies: number; ends: FrameStatusEnd[] } {
  const heard: { readies: number; ends: FrameStatusEnd[] } = { readies: 0, ends: [] };
  status.handler(undefined, context, {
    send: () => {
      heard.readies += 1;
    },
    interrupt: end => {
      heard.ends.push(end);
    },
  });
  return heard;
}

describe('the frame status', () => {
  it('As the host, I subscribe after my frame failed and hear the failure at once', () => {
    // Given
    const status = createFrameStatus();
    status.fail(new ProtocolInitFailedError('Unknown protocol mode: "nope"'));

    // When
    const heard = subscribe(status);

    // Then
    expect(heard).toEqual({
      readies: 0,
      ends: [err(domain({ tag: 'initFailed', value: 'Unknown protocol mode: "nope"' }))],
    });
  });

  it('As the host, I subscribe after my frame became ready and hear ready at once', () => {
    // Given
    const status = createFrameStatus();
    status.markReady();

    // When
    const heard = subscribe(status);

    // Then
    expect(heard).toEqual({ readies: 1, ends: [] });
  });

  it('As the host, I wait while my frame boots and hear ready once it is', () => {
    // Given
    const status = createFrameStatus();
    const heard = subscribe(status);

    // When
    status.markReady();
    status.markReady();

    // Then
    expect(heard).toEqual({ readies: 1, ends: [] });
  });

  it("As the host, I hear my status end with the fatal once my frame's light client dies after ready, and a later failure is not heard", () => {
    // Given
    const status = createFrameStatus();
    status.markReady();
    const heard = subscribe(status);

    // When
    status.fail(new ProtocolFatalError('Light client died'));
    status.fail(new ProtocolInitFailedError('too late'));
    status.interrupt(ok());
    status.markReady();
    const late = subscribe(status);

    // Then
    const fatal = err(domain({ tag: 'fatal', value: 'Light client died' }));
    expect(heard).toEqual({ readies: 1, ends: [fatal] });
    expect(late.ends).toEqual([fatal]);
  });

  it('As the host, I hear a released port, a failure of no protocol kind and a clean end each as the frame told it', () => {
    // Given three frames
    const [released, broken, stopped] = [createFrameStatus(), createFrameStatus(), createFrameStatus()];

    // When the first fails with a released port, the second with an error of no protocol kind, the third ends, and a
    // host subscribes to each after
    released.fail(new ProtocolPortReleasedError('The worker released this tab'));
    broken.fail(new TypeError('boot broke'));
    stopped.interrupt(ok());
    const ends = [released, broken, stopped].flatMap(status => subscribe(status).ends);

    // Then a protocol failure keeps its type, any other its name, and a clean end is clean
    expect(ends).toEqual([
      err(domain({ tag: 'released', value: 'The worker released this tab' })),
      err(hostFailure('TypeError: boot broke')),
      ok(),
    ]);
  });

  it("As a relay, I end the status with another frame's end as it is", () => {
    // Given
    const status = createFrameStatus();
    const heard = subscribe(status);
    const workerEnd = err(hostFailure('ProtocolRequestError: the worker gave up'));

    // When
    status.interrupt(workerEnd);

    // Then
    expect(heard.ends).toEqual([workerEnd]);
  });
});
