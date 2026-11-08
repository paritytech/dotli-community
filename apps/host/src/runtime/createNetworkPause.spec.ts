// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainPoolControl } from '@dotli/chains';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { createFakePage, createManualTimers, recordLog, type FakePage, type ManualTimers } from '@dotli/shared/testing';
import { createNetworkPause, NETWORK_PAUSE_GRACE_MS, type NetworkPause } from './createNetworkPause.js';
import { createManualPoll } from '../testing/createManualPoll.js';

let timers: ManualTimers;
let page: FakePage;
let pause: NetworkPause;
/** What every target heard, in order. */
let calls: ('pause' | 'resume')[];
let returns: number;

beforeEach(() => {
  timers = createManualTimers();
  page = createFakePage();
  pause = createNetworkPause({ timers, poll: createManualPoll({ timers }) });
  calls = [];
  returns = 0;
  pause.addTarget(createRecordingTarget());
  pause.onReturn(() => {
    returns += 1;
  });
});

describe('The network pause', () => {
  it('As a hidden page, my network pauses once the grace has passed', async () => {
    // Given
    pause.start({ visibility: page.document });
    page.setVisibility('hidden');

    // When
    await timers.advance(NETWORK_PAUSE_GRACE_MS - 1);
    const beforeGrace = [...calls];
    await timers.advance(1);

    // Then
    expect([beforeGrace, calls]).toEqual([[], ['pause']]);
  });

  it('As a page shown within the grace, nothing pauses and the monitor starts over', async () => {
    // Given
    pause.start({ visibility: page.document });
    page.setVisibility('hidden');
    await timers.advance(30_000);

    // When
    page.setVisibility('visible');
    await timers.advance(NETWORK_PAUSE_GRACE_MS);

    // Then
    expect([calls, returns]).toEqual([[], 1]);
  });

  it('As a page shown after a pause, my network resumes and the monitor starts over', async () => {
    // Given
    pause.start({ visibility: page.document });
    page.setVisibility('hidden');
    await timers.advance(NETWORK_PAUSE_GRACE_MS);

    // When
    page.setVisibility('visible');

    // Then
    expect([calls, returns]).toEqual([['pause', 'resume'], 1]);
  });

  it('As a page that loads while hidden, my network stays awake until the load ends, then the grace starts', async () => {
    // Given
    pause.start({ visibility: page.document });
    const release = pause.hold();
    page.setVisibility('hidden');
    await timers.advance(120_000);
    const whileHeld = [...calls];

    // When
    release();
    await timers.advance(NETWORK_PAUSE_GRACE_MS - 1);
    const duringGrace = [...calls];
    await timers.advance(1);

    // Then
    expect([whileHeld, duringGrace, calls]).toEqual([[], [], ['pause']]);
  });

  it('As a paused page that starts loading, my network resumes', async () => {
    // Given
    pause.start({ visibility: page.document });
    page.setVisibility('hidden');
    await timers.advance(NETWORK_PAUSE_GRACE_MS);

    // When
    pause.hold();

    // Then
    expect(calls).toEqual(['pause', 'resume']);
  });

  it('As a frozen page that thaws visible after its deadline, nothing pauses', async () => {
    // Given a page whose visibility moves without an event, as a frozen page's does
    const visibility: { visibilityState: DocumentVisibilityState } = { visibilityState: 'hidden' };
    const frozen = Object.assign(new EventTarget(), visibility);
    pause.start({ visibility: frozen });
    frozen.visibilityState = 'visible';

    // When the grace ends, and then the page's late event arrives
    await timers.advance(NETWORK_PAUSE_GRACE_MS);
    frozen.dispatchEvent(new Event('visibilitychange'));

    // Then
    expect([calls, returns]).toEqual([[], 1]);
  });

  it('As a page that slept while visible, the monitor starts over on wake', async () => {
    // Given a page whose ticks come 10 000 ms apart
    pause.start({ visibility: page.document });
    await timers.advance(10_000);
    await timers.advance(10_000);
    const beforeSleep = returns;

    // When
    timers.freeze(120_000);
    await timers.advance(10_000);

    // Then
    expect([beforeSleep, returns]).toEqual([0, 1]);
  });

  it('As a page that was hidden for long, its first tick after the return is no sleep', async () => {
    // Given
    pause.start({ visibility: page.document });
    page.setVisibility('hidden');
    await timers.advance(300_000);

    // When
    page.setVisibility('visible');
    await timers.advance(10_000);

    // Then
    expect(returns).toBe(1);
  });

  it('As a pause target added late, I hear the current state at once', async () => {
    // Given
    pause.start({ visibility: page.document });
    page.setVisibility('hidden');
    await timers.advance(NETWORK_PAUSE_GRACE_MS);
    const late: string[] = [];

    // When
    pause.addTarget({ pause: () => late.push('pause'), resume: () => late.push('resume') });

    // Then
    expect(late).toEqual(['pause']);
  });

  it('As a page whose load ended before it started following visibility, nothing pauses until start', async () => {
    // Given
    pause.hold()();
    await timers.advance(NETWORK_PAUSE_GRACE_MS);
    const beforeStart = [...calls];
    page.setVisibility('hidden');

    // When
    pause.start({ visibility: page.document });
    await timers.advance(NETWORK_PAUSE_GRACE_MS);

    // Then
    expect([beforeStart, calls]).toEqual([[], ['pause']]);
  });

  it('As a page that loads while visible, releasing its hold starts no grace', async () => {
    // Given
    pause.start({ visibility: page.document });
    pause.hold()();
    await timers.advance(30_000);
    page.setVisibility('hidden');

    // When
    await timers.advance(NETWORK_PAUSE_GRACE_MS - 1);
    const beforeGrace = [...calls];
    await timers.advance(1);

    // Then
    expect([beforeGrace, calls]).toEqual([[], ['pause']]);
  });

  it('As a page that stops following visibility while paused, my network resumes', async () => {
    // Given
    const stop = pause.start({ visibility: page.document });
    page.setVisibility('hidden');
    await timers.advance(NETWORK_PAUSE_GRACE_MS);

    // When
    stop();

    // Then
    expect(calls).toEqual(['pause', 'resume']);
  });

  it('As a hidden page that starts while loading, my grace starts only when the load ends', async () => {
    // Given
    page.setVisibility('hidden');
    const release = pause.hold();
    pause.start({ visibility: page.document });
    await timers.advance(NETWORK_PAUSE_GRACE_MS * 2);
    const whileHeld = [...calls];

    // When
    release();
    await timers.advance(NETWORK_PAUSE_GRACE_MS - 1);
    const duringGrace = [...calls];
    await timers.advance(1);

    // Then
    expect([whileHeld, duringGrace, calls]).toEqual([[], [], ['pause']]);
  });

  it('As a hidden page whose load starts during the grace, the grace starts over when the load ends', async () => {
    // Given
    pause.start({ visibility: page.document });
    page.setVisibility('hidden');
    await timers.advance(NETWORK_PAUSE_GRACE_MS - 1);

    // When
    const release = pause.hold();
    await timers.advance(NETWORK_PAUSE_GRACE_MS);
    const whileHeld = [...calls];
    release();
    await timers.advance(NETWORK_PAUSE_GRACE_MS - 1);
    const duringGrace = [...calls];
    await timers.advance(1);

    // Then
    expect([whileHeld, duringGrace, calls]).toEqual([[], [], ['pause']]);
  });

  it('As a page that removes a target and a return listener, neither hears the network again', async () => {
    // Given
    const removed: string[] = [];
    const removeTarget = pause.addTarget({ pause: () => removed.push('pause'), resume: () => removed.push('resume') });
    const removeReturn = pause.onReturn(() => removed.push('return'));
    pause.start({ visibility: page.document });
    removeTarget();
    removeReturn();

    // When
    page.setVisibility('hidden');
    await timers.advance(NETWORK_PAUSE_GRACE_MS);
    page.setVisibility('visible');

    // Then
    expect(removed).toEqual([]);
  });

  it('As a page whose target opens a load while it pauses, every target pauses and then the network resumes', async () => {
    // Given
    pause.addTarget({
      pause: () => {
        pause.hold();
      },
      resume: () => undefined,
    });
    pause.start({ visibility: page.document });
    page.setVisibility('hidden');

    // When
    await timers.advance(NETWORK_PAUSE_GRACE_MS);

    // Then
    expect(calls).toEqual(['pause', 'resume']);
  });

  it('As a page whose target opens and ends a load while it pauses, my network pauses once', async () => {
    // Given
    pause.addTarget({
      pause: () => {
        pause.hold()();
      },
      resume: () => undefined,
    });
    pause.start({ visibility: page.document });
    page.setVisibility('hidden');

    // When
    await timers.advance(NETWORK_PAUSE_GRACE_MS * 2);

    // Then
    expect(calls).toEqual(['pause']);
  });

  it('As a page whose target stops following visibility while it pauses, my network resumes', async () => {
    // Given
    let stop = (): void => undefined;
    pause.addTarget({
      pause: () => {
        stop();
      },
      resume: () => undefined,
    });
    stop = pause.start({ visibility: page.document });
    page.setVisibility('hidden');

    // When
    await timers.advance(NETWORK_PAUSE_GRACE_MS);

    // Then
    expect(calls).toEqual(['pause', 'resume']);
  });

  it('As a page shown while a target pauses, my network resumes and the monitor starts over', async () => {
    // Given
    pause.addTarget({
      pause: () => {
        page.setVisibility('visible');
      },
      resume: () => undefined,
    });
    pause.start({ visibility: page.document });
    page.setVisibility('hidden');

    // When
    await timers.advance(NETWORK_PAUSE_GRACE_MS);

    // Then
    expect([calls, returns]).toEqual([['pause', 'resume'], 1]);
  });

  it('As a pause target added while another target pauses, I am paused', async () => {
    // Given
    const late: string[] = [];
    pause.addTarget({
      pause: () => {
        pause.addTarget({ pause: () => late.push('pause'), resume: () => late.push('resume') });
      },
      resume: () => undefined,
    });
    pause.start({ visibility: page.document });
    page.setVisibility('hidden');

    // When
    await timers.advance(NETWORK_PAUSE_GRACE_MS);

    // Then
    expect([calls, late]).toEqual([['pause'], ['pause']]);
  });

  it('As a pause target removed while another target pauses, I am told nothing', async () => {
    // Given
    const removed: string[] = [];
    let removeTarget = (): void => undefined;
    pause.addTarget({
      pause: () => {
        removeTarget();
      },
      resume: () => undefined,
    });
    removeTarget = pause.addTarget({ pause: () => removed.push('pause'), resume: () => removed.push('resume') });
    pause.start({ visibility: page.document });
    page.setVisibility('hidden');

    // When
    await timers.advance(NETWORK_PAUSE_GRACE_MS);

    // Then
    expect([calls, removed]).toEqual([['pause'], []]);
  });

  it('As a pause target added while another target resumes, I am told nothing', async () => {
    // Given
    const late: string[] = [];
    pause.addTarget({
      pause: () => undefined,
      resume: () => {
        pause.addTarget({ pause: () => late.push('pause'), resume: () => late.push('resume') });
      },
    });
    pause.start({ visibility: page.document });
    page.setVisibility('hidden');
    await timers.advance(NETWORK_PAUSE_GRACE_MS);

    // When
    page.setVisibility('visible');

    // Then
    expect([calls, late]).toEqual([['pause', 'resume'], []]);
  });

  it('As a dotli maintainer, I see a breadcrumb when the network pauses and resumes', async () => {
    // Given
    const lines = recordLog({ onFinished: onTestFinished, level: 'info' });
    pause.start({ visibility: page.document });
    page.setVisibility('hidden');

    // When
    await timers.advance(NETWORK_PAUSE_GRACE_MS);
    page.setVisibility('visible');

    // Then
    expect(lines).toMatchObject([{ message: 'Network paused' }, { message: 'Network resumed' }]);
  });
});

function createRecordingTarget(): ChainPoolControl {
  return {
    pause: () => calls.push('pause'),
    resume: () => calls.push('resume'),
  };
}
