// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { recordReports } from '@dotli/metrics/testing';
import { createManualTimers } from '@dotli/shared/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createSheetHandOff } from './createSheetHandOff.js';

describe('createSheetHandOff', () => {
  it('As a menu item that opens a sheet, I run in a hand-off and the closing sheet hears it was taken', () => {
    // Given a closing sheet held by the activation, and a sheet whose memo takes the hand-off on the first flush
    const { flushes, handOff } = setup();
    const settled: boolean[] = [];
    let tookOnFlush: boolean | null = null;
    flushes.hook = () => {
      tookOnFlush ??= handOff.take();
    };

    // When the menu item runs in a hand-off, and a sheet then asks to be held
    const taken = handOff.run(() => {
      handOff.hold(wasTaken => settled.push(wasTaken));
    });
    const heldAfter = handOff.hold(() => {});

    // Then the opening sheet took it at once, the closing sheet hears it was taken, and the hand-off ended
    expect(taken).toBe(true);
    expect(tookOnFlush).toBe(true);
    expect(settled).toEqual([true]);
    expect(heldAfter).toBe(false);
  });

  it('As a menu item that opens nothing, I run in a hand-off and the closing sheet hears it was not taken', () => {
    // Given a closing sheet held by the activation, and no sheet that opens
    const { handOff } = setup();
    const settled: boolean[] = [];

    // When the menu item runs in a hand-off
    const taken = handOff.run(() => {
      handOff.hold(wasTaken => settled.push(wasTaken));
    });

    // Then nothing took it, and the closing sheet hears so
    expect(taken).toBe(false);
    expect(settled).toEqual([false]);
  });

  it('As a menu item that throws, I run in a hand-off, the closing sheet closes as without one and the throw reaches me', () => {
    // Given an activation that holds a closing sheet, then throws
    const { handOff } = setup();
    const settled: boolean[] = [];
    const failure = new Error('activation failed');

    // When the menu item runs in a hand-off, and a sheet then asks to be held
    let thrown: unknown;
    try {
      handOff.run(() => {
        handOff.hold(wasTaken => settled.push(wasTaken));
        throw failure;
      });
    } catch (error) {
      thrown = error;
    }
    const heldAfter = handOff.hold(() => {});

    // Then the throw reaches the caller, the closing sheet hears it was not taken, and the hand-off ended
    expect(thrown).toBe(failure);
    expect(settled).toEqual([false]);
    expect(heldAfter).toBe(false);
  });

  it('As a press on the bar, I close the top sheet and my click ends the hand-off', async () => {
    // Given a press that closed the top sheet, which is held, and a sheet whose memo takes the hand-off on a flush
    const { timers, target, flushes, handOff } = setup();
    const settled: boolean[] = [];
    handOff.press({ dismiss: () => handOff.hold(wasTaken => settled.push(wasTaken)), isTop: () => false });
    flushes.hook = () => {
      handOff.take();
    };

    // When the press's click arrives, and then its zero timer would be due
    target.dispatchEvent(new Event('click'));
    const flushesAfterClick = flushes.count;
    await timers.advance(0);

    // Then the closing sheet hears it was taken, and the hand-off ended once
    expect(settled).toEqual([true]);
    expect(flushes.count).toBe(flushesAfterClick);
  });

  it('As a press whose sheet stays on top with none leaving, I end the hand-off at once', () => {
    // Given a hand-off on the page
    const { timers, target, flushes, handOff } = setup();

    // When a press dismisses nothing and its sheet stays on top
    handOff.press({ dismiss: () => {}, isTop: () => true });
    const took = handOff.take();
    const flushesBeforeClick = flushes.count;
    target.dispatchEvent(new Event('click'));

    // Then no opening takes it, its click ends nothing, and it waits on no timer
    expect(took).toBe(false);
    expect(flushes.count).toBe(flushesBeforeClick);
    expect(timers.countPending()).toBe(0);
  });

  it("As a sheet that a bar control opens before the press's click reaches the window, I take the hand-off and the click ends it once", async () => {
    // Given a press that closed the top sheet, which is held
    const { timers, target, flushes, handOff } = setup();
    const settled: boolean[] = [];
    handOff.press({ dismiss: () => handOff.hold(wasTaken => settled.push(wasTaken)), isTop: () => false });

    // When the bar control's sheet opens, the click reaches the window, and then a second click and the next task come
    const took = handOff.take();
    target.dispatchEvent(new Event('click'));
    const pendingAfterClick = timers.countPending();
    const flushesAfterClick = flushes.count;
    target.dispatchEvent(new Event('click'));
    await timers.advance(0);

    // Then the opening sheet took the hand-off, the closing sheet hears it was taken, and the press waits on nothing
    expect(took).toBe(true);
    expect(settled).toEqual([true]);
    expect(pendingAfterClick).toBe(0);
    expect(flushes.count).toBe(flushesAfterClick);
  });

  it('As a menu item run after a bar control took the press, I report the take and end the press so its click and timer end nothing', async () => {
    // Given a press that closed the top sheet, which is held, and a sheet that took its hand-off
    const { timers, target, flushes, handOff } = setup();
    handOff.press({ dismiss: () => handOff.hold(() => {}), isTop: () => false });
    handOff.take();

    // When a menu item that opens nothing runs, and then the press's click and the next task come
    const taken = handOff.run(() => {});
    const pendingAfterRun = timers.countPending();
    const flushesAfterRun = flushes.count;
    target.dispatchEvent(new Event('click'));
    await timers.advance(0);

    // Then the run reports the press's take, and the press waits on nothing
    expect(taken).toBe(true);
    expect(pendingAfterRun).toBe(0);
    expect(flushes.count).toBe(flushesAfterRun);
  });

  it('As a press whose sheet opened in its dismiss and stays on top with none leaving, I end the hand-off at once', async () => {
    // Given a sheet whose memo takes the hand-off on a flush
    const { timers, target, flushes, handOff } = setup();
    flushes.hook = () => {
      handOff.take();
    };

    // When a press dismisses nothing, its sheet stays on top, and then its click and the next task come
    handOff.press({ dismiss: () => {}, isTop: () => true });
    const pendingAfterPress = timers.countPending();
    const flushesAfterPress = flushes.count;
    target.dispatchEvent(new Event('click'));
    await timers.advance(0);

    // Then the press waits on nothing
    expect(pendingAfterPress).toBe(0);
    expect(flushes.count).toBe(flushesAfterPress);
  });

  it('As a press whose click a listener stopped, I wait and the next task ends the hand-off once', async () => {
    // Given a press that closed the top sheet, which is held
    const { timers, target, flushes, handOff } = setup();
    const settled: boolean[] = [];
    handOff.press({ dismiss: () => handOff.hold(wasTaken => settled.push(wasTaken)), isTop: () => false });

    // When the next task comes with no click, and a click follows it
    await timers.advance(0);
    const flushesAfterTimer = flushes.count;
    target.dispatchEvent(new Event('click'));

    // Then the closing sheet hears once that it was not taken, and the late click ends nothing
    expect(settled).toEqual([false]);
    expect(flushes.count).toBe(flushesAfterTimer);
  });

  it('As a menu item run while a press waits, I end the press so its click and timer end nothing', () => {
    // Given a press that closed the top sheet, which is held
    const { timers, target, flushes, handOff } = setup();
    handOff.press({ dismiss: () => handOff.hold(() => {}), isTop: () => false });

    // When a menu item runs in the hand-off, and then the press's click arrives
    handOff.run(() => {});
    const flushesAfterRun = flushes.count;
    target.dispatchEvent(new Event('click'));

    // Then the press waits on no timer, and its click ends nothing
    expect(timers.countPending()).toBe(0);
    expect(flushes.count).toBe(flushesAfterRun);
  });

  it('As a closing sheet whose settle throws, I close and am reported, and the hand-off still ends', () => {
    // Given a closing sheet held by the activation, whose settle throws
    const reports = recordReports({ onFinished: onTestFinished });
    const { handOff } = setup();

    // When the menu item runs in a hand-off, and a sheet then asks to be held
    handOff.run(() => {
      handOff.hold(() => {
        throw new Error('settle failed');
      });
    });
    const heldAfter = handOff.hold(() => {});

    // Then the throw is reported as a transition defect, and the hand-off is over
    expect(reports.exceptions).toMatchObject([{ step: 'transition' }]);
    expect(heldAfter).toBe(false);
  });
  it('As a closing sheet held after one whose settle throws, I wait and am still told whether a sheet took my place', () => {
    // Given two closing sheets held by the activation, the first of which throws on its settle
    const reports = recordReports({ onFinished: onTestFinished });
    const { handOff } = setup();
    const settled: boolean[] = [];

    // When the menu item runs in a hand-off
    handOff.run(() => {
      handOff.hold(() => {
        throw new Error('settle failed');
      });
      handOff.hold(wasTaken => settled.push(wasTaken));
    });

    // Then the second sheet is told, and only the first's throw is reported
    expect(settled).toEqual([false]);
    expect(reports.exceptions).toMatchObject([{ step: 'transition' }]);
  });
});

function setup() {
  const timers = createManualTimers();
  const target = new EventTarget();
  // Stands in for a sheet's memo, which runs on a flush.
  const flushes = { count: 0, hook: (): void => {} };
  const handOff = createSheetHandOff({
    flush: () => {
      flushes.count += 1;
      flushes.hook();
    },
    target,
    timers,
  });
  return { timers, target, flushes, handOff };
}
