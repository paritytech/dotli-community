// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { must } from '@dotli/shared/testing';
import { createFakeSessionPresence } from '../session/createPagePresence.fake.js';
import type { SessionResult } from './parseSessionResult.js';
import { SIGNED_OUT_RESULT } from './roundAnswer.js';
import { createFakeMessageBus, createFakeWindowHandle, type FakeWindowHandle } from './listenToMessages.fake.js';
import { createFakePageEvents } from '../../testing/pageEvents.js';
import { createSessionHandoff } from './createSessionHandoff.js';
import { readRequestParams } from './readSessionRequest.js';
import { createHelloMessage, createRefusedMessage, createResultMessage, READY } from './sessionMessages.js';

type Params = {
  /** Whether the browser blocks every window. */
  blocked?: boolean;
  /** Whether the browser hands back a window that is already closed. */
  closedOnOpen?: boolean;
};

/** A window the page opened: its name, where it opened, and the request params its fragment carries. */
type OpenedWindow = {
  name: string;
  origin: string;
  pathname: string;
  params: ReturnType<typeof readRequestParams>;
};

const ROOT = 'https://dot.li';
const NETWORK = 'paseo-next-v2';

/** A sign-in result carrying a paired session `blob`. */
function createSessionResult(blob: string): SessionResult {
  return { session: { blob, uiState: null }, localWallet: null };
}

/** The hello for `round`, as posted to the window on the root origin. */
function createHelloPost(round: string) {
  return { message: createHelloMessage(round), target: ROOT };
}

/** The window's result for `round`, as the window sends it. */
function createWindowResult(round: string, result: unknown) {
  return createResultMessage({ round, result });
}

/** The window's refusal of `round`, as the window sends it. */
function createWindowRefusal(round: string) {
  return createRefusedMessage(round, 'origin_not_allowed');
}

/**
 * A handoff over a fake browser: a window the test answers for, a message bus, the page's return events and the
 * signed-in flag. Each window it opens is recorded with the request its fragment carries.
 */
function createPage(options: Params = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const presence = createFakeSessionPresence({ state: 'present' });
  const opened: OpenedWindow[] = [];
  const windows: FakeWindowHandle[] = [];
  const messages = createFakeMessageBus();
  const returns = createFakePageEvents();
  let rounds = 0;
  const handoff = createSessionHandoff({
    open(url, name) {
      const { origin, pathname, hash } = new URL(url);
      opened.push({ name, origin, pathname, params: readRequestParams(hash) });
      if (options.blocked === true) {
        return null;
      }
      const window = createFakeWindowHandle();
      window.closed = options.closedOnOpen === true;
      windows.push(window);
      return window;
    },
    listen: messages.listen,
    onReturn: returns.subscribe,
    randomId: () => `round-${String((rounds += 1))}`,
    windowOrigin: ROOT,
    network: () => NETWORK,
    presence,
  });
  return {
    handoff,
    metrics,
    presence,
    opened,
    windows,
    post: messages.post,
    regainFocus: returns.fire,
    countListeners: () => messages.size + returns.size,
  };
}

describe('session handoff, opener side', () => {
  it('As a user signing in on a dot.li page, I ask for the phrase window and it opens inside the call, before any await', () => {
    // Given a page with no window open
    const page = createPage();

    // When the user asks for the phrase window
    void page.handoff.signIn('phrase');

    // Then the window opened before the call returned, on the root origin with the intent, network and round
    expect(page.opened).toEqual([
      {
        name: 'dotli-session',
        origin: ROOT,
        pathname: '/s/auth',
        params: { v: 1, net: NETWORK, round: 'round-1', intent: 'phrase' },
      },
    ]);
    expect(page.metrics.counted('session_window.signin')).toEqual([{ outcome: 'opened', reason: 'phrase' }]);
  });

  it('As a user on a dot.li page, I open a window for every sign-in and sign-out and each gets a fresh round in its URL', () => {
    // Given a page with no window open
    const page = createPage();

    // When the user signs in, signs in again with a phrase and then signs out
    void page.handoff.signIn('signin');
    void page.handoff.signIn('phrase');
    page.handoff.signOut({ notified: false });

    // Then each window's request carries a round of its own
    expect(page.opened.map(open => open.params?.['round'])).toEqual(['round-1', 'round-2', 'round-3']);
  });

  it('As a user signing in on a dot.li page, I see the window say ready and the page answers with hello to the root origin only', () => {
    // Given a sign-in round whose window is open
    const page = createPage();
    void page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');

    // When ready comes from a foreign origin, from another window, and then from my window on the root origin
    page.post({ data: READY, origin: 'https://evil.li', source: window });
    page.post({ data: READY, origin: ROOT, source: createFakeWindowHandle() });
    page.post({ data: READY, origin: ROOT, source: window });

    // Then only my window hears hello, targeted at the root origin
    expect(window.posted).toEqual([createHelloPost('round-1')]);
  });

  it('As a user signing in on a dot.li page, I get results from several senders and the page takes only the one from my window, the root origin and my round', async () => {
    // Given a sign-in round whose window is open
    const page = createPage();
    const outcome = page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');

    // When results come from another window, a foreign origin, another round, in a junk shape, and then mine
    page.post({
      data: createWindowResult('round-1', createSessionResult('0xforeign-window')),
      origin: ROOT,
      source: createFakeWindowHandle(),
    });
    page.post({
      data: createWindowResult('round-1', createSessionResult('0xforeign-origin')),
      origin: 'https://x.app.dot.li',
      source: window,
    });
    page.post({
      data: createWindowResult('round-0', createSessionResult('0xstale-round')),
      origin: ROOT,
      source: window,
    });
    page.post({ data: createWindowResult('round-1', 'junk'), origin: ROOT, source: window });
    page.post({ data: createWindowResult('round-1', createSessionResult('0xmine')), origin: ROOT, source: window });

    // Then the round ends with my window's result alone
    expect(await outcome).toEqual({ kind: 'result', result: createSessionResult('0xmine') });
    expect(page.metrics.counted('session_window.signin')).toEqual([{ outcome: 'opened', reason: 'signin' }]);
    expect(page.metrics.counted('session_window.round')).toEqual([{ outcome: 'signed_in', reason: 'window' }]);
    expect(page.countListeners()).toBe(0);
  });

  it('As a user signing in on a dot.li page, I see my window answer another round and the page keeps my round going', () => {
    // Given a sign-in round whose window is open
    const page = createPage();
    void page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');

    // When my window sends a result and a refusal, both for another round
    page.post({ data: createWindowResult('round-0', createSessionResult('0xother')), origin: ROOT, source: window });
    page.post({ data: createWindowRefusal('round-0'), origin: ROOT, source: window });

    // Then the round goes on and still hears its window
    expect(page.metrics.counted('session_window.round')).toEqual([]);
    expect(page.countListeners()).toBe(2);
  });

  it('As a user signing in on a dot.li page, I see the window refuse the page and the round ends refused', async () => {
    // Given a sign-in round whose window is open
    const page = createPage();
    const outcome = page.handoff.signIn('signin');

    // When the window says it refused the page
    page.post({ data: createWindowRefusal('round-1'), origin: ROOT, source: page.windows[0] });

    // Then the round ends refused and is counted
    expect(await outcome).toEqual({ kind: 'refused' });
    expect(page.metrics.counted('session_window.round')).toEqual([{ outcome: 'refused', reason: 'window' }]);
  });

  it('As a user signing in on a dot.li page, I open a window that speaks no version the page knows and the round ends refused with no hello sent', async () => {
    // Given a sign-in round whose window is open
    const page = createPage();
    const outcome = page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');

    // When the window says ready with only a version this page does not speak
    page.post({ data: { type: 'dotli:s:ready', versions: [2] }, origin: ROOT, source: window });

    // Then no hello goes out, the round ends refused and is counted, and nothing listens any more
    expect(await outcome).toEqual({ kind: 'refused' });
    expect(window.posted).toEqual([]);
    expect(page.metrics.counted('session_window.round')).toEqual([{ outcome: 'refused', reason: 'window' }]);
    expect(page.countListeners()).toBe(0);
  });

  it('As a user signing in on a dot.li page, I press Cancel and a result arriving late is ignored', async () => {
    // Given a sign-in round whose window is open
    const page = createPage();
    const outcome = page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');

    // When the user cancels on the page and the window's result arrives late
    page.handoff.cancel('page');
    page.post({ data: createWindowResult('round-1', createSessionResult('0xlate')), origin: ROOT, source: window });

    // Then the round ended as cancelled, the window was closed and the late result was not taken
    expect(await outcome).toEqual({ kind: 'cancelled' });
    expect(window.closedByPage).toBe(1);
    expect(page.countListeners()).toBe(0);
    expect(page.metrics.counted('session_window.signin')).toEqual([{ outcome: 'opened', reason: 'signin' }]);
    expect(page.metrics.counted('session_window.round')).toEqual([{ outcome: 'cancelled', reason: 'page' }]);
  });

  it('As a user signing in on a dot.li page whose sign-in window reloads, I keep the round going and the reloaded window gets its hello', async () => {
    // Given a sign-in round whose window said ready once
    const page = createPage();
    const outcome = page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');
    const ready = { data: READY, origin: ROOT, source: window };
    page.post(ready);

    // When the page comes back while the window reloads, and the new document says ready
    page.regainFocus();
    page.post(ready);

    // Then the round is still open and both documents got the same hello
    expect(window.posted).toEqual([createHelloPost('round-1'), createHelloPost('round-1')]);
    expect(page.metrics.counted('session_window.signin')).toEqual([{ outcome: 'opened', reason: 'signin' }]);

    // When the reloaded window sends its result
    page.post({ data: createWindowResult('round-1', createSessionResult('0x01')), origin: ROOT, source: window });

    // Then the round ends with that result
    expect(await outcome).toEqual({ kind: 'result', result: createSessionResult('0x01') });
  });

  it('As a user signing in on a dot.li page, I come back to the page after closing my window and the round ends cancelled', async () => {
    // Given a sign-in round whose window is open
    const page = createPage();
    const outcome = page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');

    // When I regain focus while the window is still open
    page.regainFocus();

    // Then the round goes on
    expect(page.metrics.counted('session_window.signin')).toEqual([{ outcome: 'opened', reason: 'signin' }]);

    // When the window was closed before it posted anything and I regain focus
    window.closed = true;
    page.regainFocus();

    // Then the round ends as cancelled
    expect(await outcome).toEqual({ kind: 'cancelled' });
    expect(page.metrics.counted('session_window.round')).toEqual([{ outcome: 'cancelled', reason: 'closed' }]);
    expect(page.countListeners()).toBe(0);
  });

  it.each([
    { name: 'returns no window', options: { blocked: true } },
    { name: 'hands back a window that is already closed', options: { closedOnOpen: true } },
  ])('As a user signing in on a dot.li page whose browser $name, I sign in and the round ends blocked', async row => {
    // Given a browser that blocks the window
    const page = createPage(row.options);

    // When the user signs in
    const outcome = await page.handoff.signIn('signin');

    // Then the round ends blocked with no listener left and is counted
    expect(outcome).toEqual({ kind: 'blocked' });
    expect(page.countListeners()).toBe(0);
    expect(page.metrics.counted('session_window.signin')).toEqual([{ outcome: 'blocked', reason: 'signin' }]);
  });

  it('As a user signing in on a dot.li page, I press Sign in a second time and its window replaces the open round, which ends', async () => {
    // Given a sign-in round whose window is open
    const page = createPage();
    const first = page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');

    // When a phrase round starts and the first window then sends a result
    const second = page.handoff.signIn('phrase');
    page.post({ data: createWindowResult('round-1', createSessionResult('0xone')), origin: ROOT, source: window });
    page.post({
      data: createWindowResult('round-2', createSessionResult('0xtwo')),
      origin: ROOT,
      source: page.windows[1],
    });

    // Then the first round ended without the late word of its window, and the second took its own
    expect(await first).toEqual({ kind: 'cancelled' });
    expect(await second).toEqual({ kind: 'result', result: createSessionResult('0xtwo') });
    expect(page.opened).toHaveLength(2);
    expect(page.metrics.counted('session_window.round')).toEqual([
      { outcome: 'cancelled', reason: 'page' },
      { outcome: 'signed_in', reason: 'window' },
    ]);
  });

  it('As a user signing in on a dot.li page, I press Focus and the window of the open round comes to the front', () => {
    // Given a sign-in round whose window is open
    const page = createPage();
    void page.handoff.signIn('signin');

    // When the user presses Focus
    page.handoff.focus();

    // Then the window was focused
    expect(page.windows[0]?.focused).toBe(1);
  });

  it('As a user signing in on a dot.li page, I press Cancel and Sign in in the same turn and a new window opens inside the call', () => {
    // Given a sign-in round whose window is open
    const page = createPage();
    void page.handoff.signIn('signin');

    // When Cancel and Sign in run in one handler
    page.handoff.cancel('page');
    void page.handoff.signIn('phrase');

    // Then the second window opened before the call returned
    expect(page.opened).toHaveLength(2);
    expect(page.opened[1]?.params).toMatchObject({ intent: 'phrase' });
  });

  it('As a user signing in on a dot.li page, I see my window say ready in another version beside mine and it gets a hello for my round on the root origin', () => {
    // Given a sign-in round whose window is open
    const page = createPage();
    void page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');

    // When the window says ready speaking another version beside mine
    page.post({ data: { type: 'dotli:s:ready', versions: [2, 1] }, origin: ROOT, source: window });

    // Then the ready is answered with version 1 and my round, to the root origin
    expect(window.posted).toEqual([createHelloPost('round-1')]);
  });

  it('As a user signing out on a dot.li page while a sign-in round is open, I sign out and that round ends first', async () => {
    // Given a sign-in round whose window is open
    const page = createPage();
    const signIn = page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');

    // When the user signs out and the window then says ready
    page.handoff.signOut({ notified: true });
    const read = page.handoff.signOutRead();
    page.post({ data: READY, origin: ROOT, source: window });

    // Then the round ended as cancelled by the sign-out and the sign-out window's ready gets no hello
    expect(await signIn).toEqual({ kind: 'cancelled' });
    expect(window.posted).toEqual([]);

    // When the sign-out window reads the store
    page.post({ data: createWindowResult('round-2', SIGNED_OUT_RESULT), origin: ROOT, source: page.windows[1] });

    // Then nothing here listens any more
    await expect(read).resolves.toBeUndefined();
    expect(page.countListeners()).toBe(0);
    expect(page.metrics.counted('session_window.round')).toEqual([{ outcome: 'cancelled', reason: 'signed_out' }]);
  });

  it('As a user signing in on a dot.li page, I see the window store my sign-in before its result and the open round ends counted as a sign-in', async () => {
    // Given a sign-in round whose window is open
    const page = createPage();
    const signIn = page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');

    // When the page hears its sign-in was stored
    page.handoff.cancel('signed_in');

    // Then the round ends, its window closes and it counts as signed in from the store
    expect(await signIn).toEqual({ kind: 'cancelled' });
    expect(window.closedByPage).toBe(1);
    expect(page.metrics.counted('session_window.signin')).toEqual([{ outcome: 'opened', reason: 'signin' }]);
    expect(page.metrics.counted('session_window.round')).toEqual([{ outcome: 'signed_in', reason: 'store' }]);
  });

  it('As a user signing out on a dot.li page, I sign out and the sign-out window opens inside the call', () => {
    // Given a page with no window open
    const page = createPage();

    // When the user signs out
    page.handoff.signOut({ notified: true });

    // Then one window opened at the sign-out route with a request that says the phone was told
    expect(page.windows).toHaveLength(1);
    expect(page.opened).toEqual([
      {
        name: 'dotli-session',
        origin: ROOT,
        pathname: '/s/signout',
        params: { v: 1, net: NETWORK, round: 'round-1', notified: true },
      },
    ]);
    expect(page.metrics.counted('session_window.signout')).toEqual([{ outcome: 'opened', reason: 'notified' }]);
  });

  it('As a user signing out on a dot.li page, I see the window say ready and send its result and the page answers with hello and settles its read', async () => {
    // Given a sign-out window whose read is pending
    const page = createPage();
    page.handoff.signOut({ notified: false });
    const read = page.handoff.signOutRead();
    const window = must(page.windows[0], 'the sign-out window');

    // When the window says ready and then sends its result for my round
    page.post({ data: READY, origin: ROOT, source: window });
    page.post({ data: createWindowResult('round-1', SIGNED_OUT_RESULT), origin: ROOT, source: window });

    // Then the window heard a hello for my round, the read settled and no listener is left
    expect(window.posted).toEqual([createHelloPost('round-1')]);
    await expect(read).resolves.toBeUndefined();
    expect(page.countListeners()).toBe(0);
  });

  it.each<{ name: string; data: unknown }>([
    { name: 'refuses me', data: createWindowRefusal('round-1') },
    { name: 'speaks no version I know', data: { type: 'dotli:s:ready', versions: [2] } },
  ])(
    'As a user signing out on a dot.li page, I see my window that $name and the page settles its read and stops listening',
    async row => {
      // Given a sign-out window whose read is pending
      const page = createPage();
      page.handoff.signOut({ notified: false });
      const read = page.handoff.signOutRead();
      const window = must(page.windows[0], 'the sign-out window');

      // When the window says so
      page.post({ data: row.data, origin: ROOT, source: window });

      // Then the read settles with no hello sent and no listener left
      await expect(read).resolves.toBeUndefined();
      expect(window.posted).toEqual([]);
      expect(page.countListeners()).toBe(0);
    },
  );

  it('As a user signing out on a dot.li page, I press Sign out twice and the second press focuses the open sign-out window and waits on its read', async () => {
    // Given a sign-out window whose read is pending
    const page = createPage();
    page.handoff.signOut({ notified: false });
    const first = page.handoff.signOutRead();
    const window = must(page.windows[0], 'the sign-out window');

    // When the user signs out again
    page.handoff.signOut({ notified: false });
    const second = page.handoff.signOutRead();

    // Then no second window opened, the page still hears the first, whose read both presses share, and the flag
    // dropped once
    expect(window.focused).toBe(1);
    expect(page.opened).toHaveLength(1);
    expect(page.countListeners()).toBe(2);
    expect(second).toBe(first);
    expect(page.presence.calls).toEqual(['clear']);

    // When the window sends its result
    page.post({ data: createWindowResult('round-1', SIGNED_OUT_RESULT), origin: ROOT, source: window });

    // Then the first read settles and no listener is left
    await expect(first).resolves.toBeUndefined();
    expect(page.countListeners()).toBe(0);
  });

  it('As a user signing in on a dot.li page, I close my window and press Focus before any focus event and the round ends', async () => {
    // Given a sign-in round whose window is open
    const page = createPage();
    const outcome = page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');

    // When the user closes the window and presses Focus
    window.closed = true;
    page.handoff.focus();

    // Then the round ends cancelled without a focus and is counted as closed
    expect(await outcome).toEqual({ kind: 'cancelled' });
    expect(window.focused).toBe(0);
    expect(page.metrics.counted('session_window.round')).toEqual([{ outcome: 'cancelled', reason: 'closed' }]);
  });

  it('As a user signing out on a dot.li page, I wait for the sign-out window to read the store and only its own word counts', async () => {
    // Given a sign-out window whose read is pending
    const page = createPage();
    page.handoff.signOut({ notified: false });
    const read = page.handoff.signOutRead();
    const window = must(page.windows[0], 'the sign-out window');
    let settled = false;
    void read.then(() => {
      settled = true;
    });
    const said = createWindowResult('round-1', SIGNED_OUT_RESULT);

    // When the same word comes from another window, from another origin and for another round
    page.post({ data: said, origin: ROOT, source: createFakeWindowHandle() });
    page.post({ data: said, origin: 'https://evil.example', source: window });
    page.post({ data: createWindowResult('round-0', SIGNED_OUT_RESULT), origin: ROOT, source: window });

    // Then the page still hears its window
    expect(page.countListeners()).toBe(2);
    expect(settled).toBe(false);

    // When the window says it on the root origin
    page.post({ data: said, origin: ROOT, source: window });

    // Then the read settled on the window's own word and no listener is left
    await expect(read).resolves.toBeUndefined();
    expect(settled).toBe(true);
    expect(page.countListeners()).toBe(0);
  });

  it('As a user signing out on a dot.li page whose sign-out window closed without a word, I come back and the page stops waiting', async () => {
    // Given a sign-out window whose read is pending
    const page = createPage();
    page.handoff.signOut({ notified: false });
    const read = page.handoff.signOutRead();
    const window = must(page.windows[0], 'the sign-out window');

    // When the window closes and the page regains focus
    window.closed = true;
    page.regainFocus();

    // Then the read settles and no listener is left
    await expect(read).resolves.toBeUndefined();
    expect(page.countListeners()).toBe(0);
  });

  it('As a debug panel user whose sign-out window is still open, I ask for a phrase and that window comes to the front while the sign-out still waits for its read', async () => {
    // Given a sign-out window that has not read yet
    const page = createPage();
    let read = false;
    page.handoff.signOut({ notified: false });
    const windowRead = page.handoff.signOutRead();
    const signOut = windowRead.then(() => {
      read = true;
    });
    const window = must(page.windows[0], 'the sign-out window');

    // When the debug panel asks for a phrase meanwhile
    const signIn = await page.handoff.signIn('phrase');

    // Then no window took the sign-out window's place, and the sign-out waits on
    expect(signIn).toEqual({ kind: 'cancelled' });
    expect(page.opened).toHaveLength(1);
    expect(window.focused).toBe(1);
    expect(read).toBe(false);
    expect(page.metrics.counted('session_window.signin')).toEqual([{ outcome: 'busy', reason: 'phrase' }]);

    // When the window reads
    page.post({ data: createWindowResult('round-1', SIGNED_OUT_RESULT), origin: ROOT, source: window });
    await signOut;

    // Then the sign-out still settled on the window's read
    expect(read).toBe(true);
  });

  it('As a user signing out on a dot.li page whose browser blocks the window, I sign out, the flag goes and the read settles at once with no window to wait on', async () => {
    // Given a browser that blocks the window
    const page = createPage({ blocked: true });

    // When the user signs out and the page asks for the read
    page.handoff.signOut({ notified: false });
    const read = page.handoff.signOutRead();

    // Then the flag went all the same, and no window will read anything, so nothing waits on one
    await expect(read).resolves.toBeUndefined();
    expect(page.presence.calls).toEqual(['clear']);
    expect(page.countListeners()).toBe(0);
    expect(page.opened[0]?.params).not.toHaveProperty('notified');
    expect(page.metrics.counted('session_window.signout')).toEqual([{ outcome: 'blocked', reason: 'unnotified' }]);
  });

  it('As a user signing in on a dot.li page with no sign-out window open, I ask for the sign-out read and get a settled one', async () => {
    // Given a sign-in round open, which is no sign-out window
    const page = createPage();
    void page.handoff.signIn('signin');

    // When the page asks for the read
    const read = page.handoff.signOutRead();

    // Then it is settled and the flag was not touched
    await expect(read).resolves.toBeUndefined();
    expect(page.presence.calls).toEqual([]);
  });
});
