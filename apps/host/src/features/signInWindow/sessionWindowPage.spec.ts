// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { closePage, type ClosablePage } from './sessionWindowPage.js';

type Params = {
  /** Whether the browser lets a script close the page. */
  closable: boolean;
};

describe('session window page', () => {
  it('As a user of a window a script may close, I press Close and the window closes without going back', () => {
    // Given a window the browser lets close
    const { page, calls } = createFakePage({ closable: true });

    // When the window closes its page
    closePage(page);

    // Then it closed and never went back
    expect(calls).toEqual(['close']);
  });

  it('As a user of a tab the browser keeps open, I press Close and the tab goes back in history', () => {
    // Given a tab a site navigated, which the browser keeps open
    const { page, calls } = createFakePage({ closable: false });

    // When the window closes its page
    closePage(page);

    // Then it tried to close, then went back
    expect(calls).toEqual(['close', 'back']);
  });
});

/** Builds a page whose `close` closes it only when `closable`, and which records each close and each step back. */
function createFakePage({ closable }: Params): { page: ClosablePage; calls: string[] } {
  const calls: string[] = [];
  let closed = false;
  const page: ClosablePage = {
    close() {
      calls.push('close');
      closed = closable;
    },
    get closed() {
      return closed;
    },
    history: {
      back() {
        calls.push('back');
      },
    },
  };
  return { page, calls };
}
