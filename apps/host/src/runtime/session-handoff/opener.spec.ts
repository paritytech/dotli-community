// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import { must } from '@dotli/shared/testing';
import { createFakeSessionPresence } from '../session/presence.fake.js';
import type { SessionResult } from './messages.js';
import { createFakeMessageBus, createFakeWindowHandle, type FakeWindowHandle } from './messages.fake.js';
import { createFakePageEvents } from '../../testing/page-events.js';
import { createSessionHandoff, type SignInOutcome } from './opener.js';

const ROOT = 'https://dot.li';
const NETWORK = 'paseo-next-v2';

const resultWith = (blob: string): SessionResult => ({ session: { blob, uiState: null }, localWallet: null });

/**
 * A handoff over a fake browser: a window the test answers for, a message bus, the page's return events and the
 * signed-in flag.
 */
function harness(options: { blocked?: boolean; closedOnOpen?: boolean } = {}) {
  const metrics = bindRecordingSentry({ onFinished: onTestFinished });
  const presence = createFakeSessionPresence('present');
  const opened: { url: URL; name: string }[] = [];
  const windows: FakeWindowHandle[] = [];
  const messages = createFakeMessageBus();
  const returns = createFakePageEvents();
  let rounds = 0;
  const handoff = createSessionHandoff({
    open: (url, name) => {
      opened.push({ url: new URL(url), name });
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
    listeners: () => messages.size + returns.size,
  };
}

describe('session handoff, opener side', () => {
  it('As a page, I open the window inside the call before any await', () => {
    // Given a page with no window open
    const page = harness();

    // When the user asks for the phrase window
    void page.handoff.signIn('phrase');

    // Then the window opened before the call returned, on the root origin with the intent and network
    const [open] = page.opened;
    expect(page.opened).toHaveLength(1);
    expect(open?.name).toBe('dotli-session');
    expect(open?.url.origin).toBe(ROOT);
    expect(open?.url.pathname).toBe('/__session');
    expect(open?.url.searchParams.get('intent')).toBe('phrase');
    expect(open?.url.searchParams.get('net')).toBe(NETWORK);
    expect(page.metrics.counted('session_window.signin')).toEqual([{ outcome: 'opened', reason: 'phrase' }]);
  });

  it('As a page resuming a sign-in made elsewhere, I open the window and its URL and my hello both carry the resume intent', () => {
    // Given a resume round whose window is open
    const page = harness();
    void page.handoff.signIn('resume');
    const window = must(page.windows[0], 'the window');

    // When the window says ready
    page.post({ data: { type: 'dotli:session:ready' }, origin: ROOT, source: window });

    // Then the URL and the hello name resume and the open is counted under it
    expect(page.opened[0]?.url.searchParams.get('intent')).toBe('resume');
    expect(window.posted).toEqual([
      { message: { type: 'dotli:session:hello', round: 'round-1', intent: 'resume' }, target: ROOT },
    ]);
    expect(page.metrics.counted('session_window.signin')).toEqual([{ outcome: 'opened', reason: 'resume' }]);
  });

  it('As a page, I answer ready with hello to the root origin only', () => {
    // Given a sign-in round whose window is open
    const page = harness();
    void page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');
    const ready = { type: 'dotli:session:ready' };

    // When ready comes from a foreign origin, from another window, and then from my window on the root origin
    page.post({ data: ready, origin: 'https://evil.li', source: window });
    page.post({ data: ready, origin: ROOT, source: createFakeWindowHandle() });
    page.post({ data: ready, origin: ROOT, source: window });

    // Then only my window hears hello, targeted at the root origin
    expect(window.posted).toEqual([
      { message: { type: 'dotli:session:hello', round: 'round-1', intent: 'signin' }, target: ROOT },
    ]);
  });

  it('As a page, I take a result only from my window, from the root origin, with my round', async () => {
    // Given a sign-in round whose window is open
    const page = harness();
    const outcome = page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');
    const result = (round: string, blob: string) => ({ type: 'dotli:session:result', round, result: resultWith(blob) });

    // When results come from another window, a foreign origin, another round, in a junk shape, and then mine
    page.post({ data: result('round-1', '0xforeign-window'), origin: ROOT, source: createFakeWindowHandle() });
    page.post({ data: result('round-1', '0xforeign-origin'), origin: 'https://x.app.dot.li', source: window });
    page.post({ data: result('round-0', '0xstale-round'), origin: ROOT, source: window });
    page.post({
      data: { type: 'dotli:session:result', round: 'round-1', result: 'junk' },
      origin: ROOT,
      source: window,
    });
    page.post({ data: result('round-1', '0xmine'), origin: ROOT, source: window });

    // Then the round ends with my window's result alone
    expect(await outcome).toEqual({ kind: 'result', result: resultWith('0xmine') });
    expect(page.metrics.counted('session_window.signin')).toEqual([{ outcome: 'opened', reason: 'signin' }]);
    expect(page.metrics.counted('session_window.round')).toEqual([{ outcome: 'signed_in', reason: 'window' }]);
    expect(page.listeners()).toBe(0);
  });

  it('As a page, I learn that the window refused me', async () => {
    // Given a sign-in round whose window is open
    const page = harness();
    const outcome = page.handoff.signIn('signin');

    // When the window says it refused the page
    page.post({ data: { type: 'dotli:session:refused', round: 'round-1' }, origin: ROOT, source: page.windows[0] });

    // Then the round ends refused and is counted
    expect(await outcome).toEqual({ kind: 'refused' });
    expect(page.metrics.counted('session_window.round')).toEqual([{ outcome: 'refused', reason: 'window' }]);
  });

  it('As a page, I ignore a result after Cancel', async () => {
    // Given a sign-in round whose window is open
    const page = harness();
    const outcome = page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');

    // When the user cancels on the page and the window's result arrives late
    page.handoff.cancel('page');
    page.post({
      data: { type: 'dotli:session:result', round: 'round-1', result: resultWith('0xlate') },
      origin: ROOT,
      source: window,
    });

    // Then the round ended as cancelled, the window was closed and the late result was not taken
    expect(await outcome).toEqual({ kind: 'cancelled' });
    expect(window.closedByPage).toBe(1);
    expect(page.listeners()).toBe(0);
    expect(page.metrics.counted('session_window.signin')).toEqual([{ outcome: 'opened', reason: 'signin' }]);
    expect(page.metrics.counted('session_window.round')).toEqual([{ outcome: 'cancelled', reason: 'page' }]);
  });

  it('As a page whose sign-in window reloads, I keep the round going and the reloaded window gets its hello', async () => {
    // Given a sign-in round whose window said ready once
    const page = harness();
    const outcome = page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');
    const ready = { data: { type: 'dotli:session:ready' }, origin: ROOT, source: window };
    page.post(ready);

    // When the page comes back while the window reloads, and the new document says ready
    page.regainFocus();
    page.post(ready);

    // Then the round is still open and both documents got the same hello
    const hello = { type: 'dotli:session:hello', round: 'round-1', intent: 'signin' };
    expect(window.posted).toEqual([
      { message: hello, target: ROOT },
      { message: hello, target: ROOT },
    ]);
    expect(page.metrics.counted('session_window.signin')).toEqual([{ outcome: 'opened', reason: 'signin' }]);

    // When the reloaded window sends its result
    page.post({
      data: { type: 'dotli:session:result', round: 'round-1', result: resultWith('0x01') },
      origin: ROOT,
      source: window,
    });

    // Then the round ends with that result
    expect(await outcome).toEqual({ kind: 'result', result: resultWith('0x01') });
  });

  it('As a page, I hear an old window document say cancelled as it closes and keep the round going', () => {
    // Given a sign-in round whose window is open
    const page = harness();
    void page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');

    // When an old window document says cancelled, and is closed
    window.closed = true;
    page.post({ data: { type: 'dotli:session:cancelled', round: 'round-1' }, origin: ROOT, source: window });

    // Then the round goes on until the page finds the window closed
    expect(page.metrics.counted('session_window.signin')).toEqual([{ outcome: 'opened', reason: 'signin' }]);
    expect(page.listeners()).toBe(2);
  });

  it('As a page, I get cancelled when I regain focus and my window is closed', async () => {
    // Given a sign-in round whose window is open
    const page = harness();
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
    expect(page.listeners()).toBe(0);
  });

  it('As a page, I get blocked when the browser returns no window', async () => {
    // Given a browser that blocks the window
    const page = harness({ blocked: true });

    // When the user signs in
    const outcome = await page.handoff.signIn('signin');

    // Then the round ends blocked with no listener left and is counted
    expect(outcome).toEqual({ kind: 'blocked' });
    expect(page.listeners()).toBe(0);
    expect(page.metrics.counted('session_window.signin')).toEqual([{ outcome: 'blocked', reason: 'signin' }]);
  });

  it('As a page, I take a second Sign in and its window replaces the open round, which ends', async () => {
    // Given a sign-in round whose window is open
    const page = harness();
    const first = page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');

    // When a phrase round starts and the first window then sends a result
    const second = page.handoff.signIn('phrase');
    page.post({
      data: { type: 'dotli:session:result', round: 'round-1', result: resultWith('0xone') },
      origin: ROOT,
      source: window,
    });
    page.post({
      data: { type: 'dotli:session:result', round: 'round-2', result: resultWith('0xtwo') },
      origin: ROOT,
      source: page.windows[1],
    });

    // Then the first round ended without the late word of its window, and the second took its own
    const expected: SignInOutcome = { kind: 'result', result: resultWith('0xtwo') };
    expect(await first).toEqual({ kind: 'cancelled' });
    expect(await second).toEqual(expected);
    expect(page.opened).toHaveLength(2);
    expect(page.metrics.counted('session_window.round')).toEqual([
      { outcome: 'cancelled', reason: 'page' },
      { outcome: 'signed_in', reason: 'window' },
    ]);
  });

  it('As a page, I take Focus and the window of the open round comes to the front', () => {
    // Given a sign-in round whose window is open
    const page = harness();
    void page.handoff.signIn('signin');

    // When the user presses Focus
    page.handoff.focus();

    // Then the window was focused
    expect(page.windows[0]?.focused).toBe(1);
  });

  it('As a page, I open a new window inside the call when I sign in right after Cancel in the same turn', () => {
    // Given a sign-in round whose window is open
    const page = harness();
    void page.handoff.signIn('signin');

    // When Cancel and Sign in run in one handler
    page.handoff.cancel('page');
    void page.handoff.signIn('phrase');

    // Then the second window opened before the call returned
    expect(page.opened).toHaveLength(2);
    expect(page.opened[1]?.url.searchParams.get('intent')).toBe('phrase');
  });

  it('As a page, I get blocked when the browser hands back a window that is already closed', async () => {
    // Given a browser that hands back a closed window
    const page = harness({ closedOnOpen: true });

    // When the user signs in
    const outcome = await page.handoff.signIn('signin');

    // Then the round ends blocked with no listener left and is counted
    expect(outcome).toEqual({ kind: 'blocked' });
    expect(page.listeners()).toBe(0);
    expect(page.metrics.counted('session_window.signin')).toEqual([{ outcome: 'blocked', reason: 'signin' }]);
  });

  it('As a page, I answer every ready with hello, to the root origin only', () => {
    // Given a sign-in round whose window is open
    const page = harness();
    void page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');
    const hello = { message: { type: 'dotli:session:hello', round: 'round-1', intent: 'signin' }, target: ROOT };

    // When the window says ready twice, the second time after a reload
    page.post({ data: { type: 'dotli:session:ready' }, origin: ROOT, source: window });
    page.post({ data: { type: 'dotli:session:ready' }, origin: ROOT, source: window });

    // Then each ready is answered, each time to the root origin
    expect(window.posted).toEqual([hello, hello]);
  });

  it('As a page signing out while a sign-in round is open, I end that round first', async () => {
    // Given a sign-in round whose window is open
    const page = harness();
    const signIn = page.handoff.signIn('signin');
    const window = must(page.windows[0], 'the window');

    // When the user signs out and the window then says ready
    page.handoff.signOut({ notified: true });
    const read = page.handoff.signOutRead();
    page.post({ data: { type: 'dotli:session:ready' }, origin: ROOT, source: window });

    // Then the round ended as cancelled by the sign-out and the sign-out window's ready gets no hello
    expect(await signIn).toEqual({ kind: 'cancelled' });
    expect(window.posted).toEqual([]);
    // and once the sign-out window read the store, nothing here listens any more
    page.post({ data: { type: 'dotli:session:signed-out-read' }, origin: ROOT, source: page.windows[1] });
    await read;
    expect(page.listeners()).toBe(0);
    expect(page.metrics.counted('session_window.round')).toEqual([{ outcome: 'cancelled', reason: 'signed_out' }]);
  });

  it('As a page that hears the window store my sign-in before its result, I end the open round and count it as a sign-in', async () => {
    // Given a sign-in round whose window is open
    const page = harness();
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

  it('As a page, I start a new round once the last one ended', async () => {
    // Given a round the page cancelled
    const page = harness();
    const first = page.handoff.signIn('signin');
    page.handoff.cancel('page');
    await first;

    // When the user signs in again and the new window says ready
    void page.handoff.signIn('signin');
    page.post({ data: { type: 'dotli:session:ready' }, origin: ROOT, source: page.windows[1] });

    // Then a second window opened in the call and heard the new round
    expect(page.opened).toHaveLength(2);
    expect(page.windows[1]?.posted).toEqual([
      { message: { type: 'dotli:session:hello', round: 'round-2', intent: 'signin' }, target: ROOT },
    ]);
  });

  it('As a page signing out, I open the sign-out window inside the call', () => {
    // Given a page with no window open
    const page = harness();

    // When the user signs out
    page.handoff.signOut({ notified: true });

    // Then one window opened at the sign-out URL
    const [open] = page.opened;
    expect(page.windows).toHaveLength(1);
    expect(open?.name).toBe('dotli-session');
    expect(open?.url.origin).toBe(ROOT);
    expect(open?.url.searchParams.get('intent')).toBe('signout');
    expect(open?.url.searchParams.get('notified')).toBe('1');
    expect(page.metrics.counted('session_window.signout')).toEqual([{ outcome: 'opened', reason: 'notified' }]);
  });

  it('As a page whose user presses Sign out twice, I focus the open sign-out window on the second press and wait on its read', async () => {
    // Given a sign-out window whose read is pending
    const page = harness();
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
    expect(page.listeners()).toBe(2);
    expect(second).toBe(first);
    expect(page.presence.calls).toEqual(['clear']);

    // When the window says it read the store
    page.post({ data: { type: 'dotli:session:signed-out-read' }, origin: ROOT, source: window });

    // Then the first read settles and no listener is left
    await first;
    expect(page.listeners()).toBe(0);
  });

  it('As a page back before any focus event, I take Focus on a window the user closed and the round ends', async () => {
    // Given a sign-in round whose window is open
    const page = harness();
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

  it('As a page signing out, I wait for the sign-out window to read the store, and only its own word counts', async () => {
    // Given a sign-out window whose read is pending
    const page = harness();
    page.handoff.signOut({ notified: false });
    const read = page.handoff.signOutRead();
    const window = must(page.windows[0], 'the sign-out window');
    let settled = false;
    void read.then(() => {
      settled = true;
    });
    const said = { type: 'dotli:session:signed-out-read' };

    // When the same word comes from another window and from another origin
    page.post({ data: said, origin: ROOT, source: createFakeWindowHandle() });
    page.post({ data: said, origin: 'https://evil.example', source: window });

    // Then the page still hears its window
    expect(page.listeners()).toBe(2);
    expect(settled).toBe(false);

    // When the window says it on the root origin
    page.post({ data: said, origin: ROOT, source: window });

    // Then the read settled on the window's own word and no listener is left
    await read;
    expect(settled).toBe(true);
    expect(page.listeners()).toBe(0);
  });

  it('As a page signing out whose sign-out window closed without a word, I stop waiting once I am back', async () => {
    // Given a sign-out window whose read is pending
    const page = harness();
    page.handoff.signOut({ notified: false });
    const read = page.handoff.signOutRead();
    const window = must(page.windows[0], 'the sign-out window');

    // When the window closes and the page regains focus
    window.closed = true;
    page.regainFocus();

    // Then the read settles and no listener is left
    await read;
    expect(page.listeners()).toBe(0);
  });

  it('As a page whose sign-out window is still open, I take a sign-in and bring that window to the front while the sign-out still waits for its read', async () => {
    // Given a sign-out window that has not read yet
    const page = harness();
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
    page.post({ data: { type: 'dotli:session:signed-out-read' }, origin: ROOT, source: window });
    await signOut;

    // Then the sign-out still settled on the window's read
    expect(read).toBe(true);
  });

  it('As a page signing out with the window blocked, I wait on no window and my read settles at once', async () => {
    // Given a browser that blocks the window
    const page = harness({ blocked: true });

    // When the user signs out and the page asks for the read
    page.handoff.signOut({ notified: false });
    const read = page.handoff.signOutRead();

    // Then: no window will read anything, so nothing waits on one
    await expect(read).resolves.toBeUndefined();
    expect(page.listeners()).toBe(0);
    expect(page.opened[0]?.url.searchParams.has('notified')).toBe(false);
    expect(page.metrics.counted('session_window.signout')).toEqual([{ outcome: 'blocked', reason: 'unnotified' }]);
  });

  it('As a signed-in user, I sign out and the flag drops in the same turn the window opens', () => {
    // Given a page with no window open
    const page = harness();

    // When the user signs out
    page.handoff.signOut({ notified: true });

    // Then the window opened and the flag went before the call returned
    expect(page.windows).toHaveLength(1);
    expect(page.presence.calls).toEqual(['clear']);
  });

  it('As a signed-in user whose sign-out window is blocked, I sign out and its read is settled at once', async () => {
    // Given a browser that blocks the window
    const page = harness({ blocked: true });

    // When the user signs out and the page asks for the read
    page.handoff.signOut({ notified: true });
    const read = page.handoff.signOutRead();

    // Then the flag went all the same, and nothing is left to wait for
    expect(page.presence.calls).toEqual(['clear']);
    expect(page.listeners()).toBe(0);
    await expect(read).resolves.toBeUndefined();
  });

  it('As a page with no sign-out window open, I ask for its read and get a settled one', async () => {
    // Given a sign-in round open, which is no sign-out window
    const page = harness();
    void page.handoff.signIn('signin');

    // When the page asks for the read
    const read = page.handoff.signOutRead();

    // Then it is settled and the flag was not touched
    await expect(read).resolves.toBeUndefined();
    expect(page.presence.calls).toEqual([]);
  });
});
