// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { createShellState, type ShellPart, type ShellState } from './shell-state.js';

/** What a start that is expected to fail threw. */
function startFailure(shell: ShellState): unknown {
  try {
    shell.start();
  } catch (err: unknown) {
    return err;
  }
  throw new Error('the shell state started');
}

/** A part that records its starts and stops in `log`, running `onStart` as it starts. */
function recordingPart(log: string[], name: string, onStart: () => void = () => undefined): ShellPart {
  return () => {
    log.push(`start ${name}`);
    onStart();
    return () => {
      log.push(`stop ${name}`);
    };
  };
}

describe('createShellState', () => {
  it('As the boot, starting the shell state twice starts it once, so one stop ends it', () => {
    // Given
    const log: string[] = [];
    const shell = createShellState([recordingPart(log, 'theme'), recordingPart(log, 'topbar')]);
    const first = shell.start();

    // When
    const second = shell.start();
    second();

    // Then
    expect(second).toBe(first);
    expect(log).toEqual(['start theme', 'start topbar', 'stop topbar', 'stop theme']);
  });

  it('As a store listener that starts the shell state while it starts, I get the same stop and start nothing twice', () => {
    // Given: a part whose first write reaches a listener that starts the shell state again
    const log: string[] = [];
    let inner: (() => void) | undefined;
    const shell: ShellState = createShellState([
      recordingPart(log, 'topbar', () => {
        inner ??= shell.start();
      }),
      recordingPart(log, 'theme'),
    ]);

    // When
    const outer = shell.start();
    outer();

    // Then
    expect(inner).toBe(outer);
    expect(log).toEqual(['start topbar', 'start theme', 'stop theme', 'stop topbar']);
  });

  it('As the shell, once stopped, none of my parts runs and the next start starts them afresh', () => {
    // Given
    const log: string[] = [];
    const shell = createShellState([recordingPart(log, 'theme'), recordingPart(log, 'topbar')]);
    shell.start();

    // When
    shell.stop();
    shell.stop();

    // Then
    expect(log).toEqual(['start theme', 'start topbar', 'stop topbar', 'stop theme']);

    // When
    log.length = 0;
    shell.start();

    // Then
    expect(log).toEqual(['start theme', 'start topbar']);
  });

  it('As the boot, a shell state whose third part fails to start leaves nothing running, and the next start starts every part again', () => {
    // Given: parts that record their starts and stops, the third failing once
    const log: string[] = [];
    let failures = 1;
    const part =
      (name: string, fails = false) =>
      (): (() => void) => {
        if (fails && failures > 0) {
          failures -= 1;
          throw new Error(`${name} did not start`);
        }
        log.push(`start ${name}`);
        return () => {
          log.push(`stop ${name}`);
        };
      };
    const shell = createShellState([part('theme'), part('network'), part('health', true), part('chat')]);

    // When
    const failure = startFailure(shell);

    // Then the start fails with the part's own error as its cause, and the parts already started are stopped
    expect(failure).toMatchObject({ message: 'Shell state did not start', cause: { message: 'health did not start' } });
    expect(log).toEqual(['start theme', 'start network', 'stop network', 'stop theme']);

    // When
    log.length = 0;
    const stop = shell.start();
    stop();

    // Then
    expect(log).toEqual([
      'start theme',
      'start network',
      'start health',
      'start chat',
      'stop chat',
      'stop health',
      'stop network',
      'stop theme',
    ]);
  });

  it('As the boot, a shell state part whose stop throws while a failed start unwinds is reported, and the start still fails with its own cause', () => {
    // Given a network part whose stop throws, a health part that fails to start, and a reporting pipeline that records
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const stopFailure = new TypeError('network did not stop');
    const log: string[] = [];
    const shell = createShellState([
      () => {
        log.push('start theme');
        return () => {
          log.push('stop theme');
        };
      },
      () => {
        log.push('start network');
        return () => {
          throw stopFailure;
        };
      },
      () => {
        throw new Error('health did not start');
      },
    ]);

    // When
    const failure = startFailure(shell);

    // Then the start error keeps its cause, the unwind went on to the theme, and the stop failure was reported once
    expect(failure).toMatchObject({ message: 'Shell state did not start', cause: { message: 'health did not start' } });
    expect(log).toEqual(['start theme', 'start network', 'stop theme']);
    expect(captures.exception).toHaveBeenCalledTimes(1);
    expect(captures.exception).toHaveBeenCalledWith(stopFailure, { flow: 'ui', step: 'shell_part_stop' });
    expect(metrics.counted('shell_state.stop')).toEqual([{ outcome: 'error', reason: 'TypeError' }]);
  });
});
