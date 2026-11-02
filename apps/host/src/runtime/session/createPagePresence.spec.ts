// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDeferred } from '@dotli/shared';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import type { SharedChannel } from '../sharedMode.js';
import { createMemorySharedChannel } from '../sharedMode.fake.js';
import { isFlagShared } from '../pageRole.js';
import type { CookieJar } from './createCookiePresence.js';
import { createFakeCookieJar } from './createCookiePresence.fake.js';
import { bindReports } from '../../testing/bindReports.js';
import { getUnservedChannel } from './createPagePresence.fake.js';
import { createPagePresence } from './createPagePresence.js';

const DOMAIN = 'dot.li';

describe('guarded presence', () => {
  it('As a user whose flag read rejects, I read the flag and get unknown, and it is counted as expected', async () => {
    // Given a flag whose read rejects
    const { captures, counted } = bindReports();
    const failure = new Error('cookie blocked');
    const jar: CookieJar = {
      read() {
        throw failure;
      },
      write: () => undefined,
    };
    const presence = createPagePresence({ isShared: () => true, localhost: false, channel: getUnservedChannel, jar });

    // When the page reads it
    const result = await presence.read();

    // Then it reads unknown, the miss is a breadcrumb, not an issue, and it is counted with its class name
    expect(result).toBe('unknown');
    expect(captures.expected).toHaveBeenCalledWith(failure, { flow: 'wallet', step: 'presence_read' });
    expect(captures.exception).not.toHaveBeenCalled();
    expect(counted('session.presence_read')).toEqual([{ outcome: 'error', reason: 'Error' }]);
  });

  it('As a user whose flag write throws, I set the flag and go on while the failure is counted', async () => {
    // Given a flag whose write throws
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    onTestFinished(bindCaptureSink({ exception: vi.fn(), expected: vi.fn() }));
    const jar: CookieJar = {
      read: () => '',
      write() {
        throw new Error('cookie blocked');
      },
    };
    const presence = createPagePresence({ isShared: () => true, localhost: false, channel: getUnservedChannel, jar });

    // When the page sets it
    await presence.set();

    // Then the failure is counted
    expect(metrics.counted('session.flag_write')).toEqual([{ outcome: 'error', reason: 'set' }]);
  });
});

describe('page presence', () => {
  it('As a user on a preview its preview host frames, I use my flag and it reads unknown and is never written even where cookies work', async () => {
    // Given a framed preview, whose sign-in sits in its preview host's partition, apart from the main store
    const jar = createFakeCookieJar();
    jar.write(`has_session=1; Domain=${DOMAIN}; Path=/; Secure; SameSite=Lax; Max-Age=60`);
    jar.written.length = 0;
    const presence = createPagePresence({
      isShared: () => isFlagShared('framed-preview'),
      localhost: false,
      channel: getUnservedChannel,
      jar,
    });

    // When the flag is read, set, cleared and renewed
    const read = await presence.read();
    void presence.set();
    void presence.clear();
    void presence.renew();

    // Then it reads unknown and the jar was never touched
    expect(read).toBe('unknown');
    expect(jar.written).toEqual([]);
    expect(jar.reads()).toBe(0);
  });

  it.each(['page', 'preview', 'signin-window', 'signout-window'] as const)(
    'As a user on a deployed %s, I set the cookie flag and read it present',
    async role => {
      // Given the page's flag for that role on a working jar
      const jar = createFakeCookieJar();
      const presence = createPagePresence({
        isShared: () => isFlagShared(role),
        localhost: false,
        channel: getUnservedChannel,
        jar,
      });

      // When the flag is set and read
      void presence.set();
      const read = await presence.read();

      // Then it reads present
      expect(read).toBe('present');
    },
  );

  it('As a user on a deployed page, I renew my flag and it is written again only while it is still set', async () => {
    // Given one page whose jar holds the flag and one whose flag a sign-out elsewhere deleted
    const held = createFakeCookieJar();
    held.write(`has_session=1; Domain=${DOMAIN}; Path=/; Secure; SameSite=Lax; Max-Age=60`);
    held.written.length = 0;
    const deleted = createFakeCookieJar();

    // When each page renews its flag
    await createDeployedPresence(held).renew();
    await createDeployedPresence(deleted).renew();

    // Then only the flag still set was written again, with its full lifetime
    expect(held.written).toEqual(['has_session=1; Domain=dot.li; Path=/; Secure; SameSite=Lax; Max-Age=34560000']);
    expect(deleted.written).toEqual([]);
  });

  it('As a developer on a local page, I read the flag while the dev store fails and get unknown', async () => {
    // Given a flag over a dev store that fails
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const channel = createMemorySharedChannel();
    channel.readFails = true;
    const presence = createPagePresence({
      isShared: () => true,
      localhost: true,
      channel: () => channel,
      jar: createFakeCookieJar(),
    });

    // When the flag is read
    const result = await presence.read();

    // Then it reads unknown and the miss is a breadcrumb
    expect(result).toBe('unknown');
    expect(captures.expected).toHaveBeenCalledWith(expect.any(Error), { flow: 'wallet', step: 'presence_read' });
    expect(captures.exception).not.toHaveBeenCalled();
  });

  it('As a user renewing the flag, I renew while the write fails and go on while the failure is counted', async () => {
    // Given a jar that holds the flag and whose write throws
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    onTestFinished(bindCaptureSink({ exception: vi.fn(), expected: vi.fn() }));
    const jar: CookieJar = {
      read: () => 'has_session=1',
      write() {
        throw new Error('cookie blocked');
      },
    };

    // When the flag is renewed
    const renewing = createPagePresence({
      isShared: () => true,
      localhost: false,
      channel: getUnservedChannel,
      jar,
    }).renew();

    // Then the renew resolves and its failure is counted
    await expect(renewing).resolves.toBeUndefined();
    expect(metrics.counted('session.flag_write')).toEqual([{ outcome: 'error', reason: 'renew' }]);
  });

  it('As a user signing out, I clear my flag and the cookie is deleted in the same turn', () => {
    // Given a deployed page's flag on a working jar
    const jar = createFakeCookieJar();
    const presence = createPagePresence({ isShared: () => true, localhost: false, channel: getUnservedChannel, jar });

    // When the flag is cleared and nothing is awaited
    void presence.clear();

    // Then the cookie was already deleted
    expect(jar.written).toEqual(['has_session=1; Domain=dot.li; Path=/; Secure; SameSite=Lax; Max-Age=0']);
  });
});

describe('presence writes', () => {
  it('As a developer on a local page, I set my flag and the write settles only once the dev store took it', async () => {
    // Given a dev store whose write is held
    const written = createDeferred<undefined>();
    const asked = createDeferred<undefined>();
    const writes: string[] = [];
    const channel: SharedChannel = {
      read: () => Promise.resolve(null),
      write(key) {
        writes.push(key);
        asked.resolve(undefined);
        return written.promise;
      },
      clear: () => Promise.resolve(),
    };
    let settled = false;
    const presence = createPagePresence({
      isShared: () => true,
      localhost: true,
      channel: () => channel,
      jar: createFakeCookieJar(),
    });

    // When the flag is set
    const setting = presence.set().then(() => {
      settled = true;
    });
    await asked.promise;

    // Then the write was asked and has not settled
    expect(writes).toEqual(['has_session']);
    expect(settled).toBe(false);

    // When the dev store takes the write
    written.resolve(undefined);
    await setting;

    // Then the write settles
    expect(settled).toBe(true);
  });

  it('As a developer on localhost where nothing serves the dev store, I set and clear my flag and each write settles as a breadcrumb and a count, not an issue', async () => {
    // Given a localhost page whose dev store is down
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const failure = new Error('dev store down');
    const channel: SharedChannel = {
      read: () => Promise.reject(failure),
      write: () => Promise.reject(failure),
      clear: () => Promise.reject(failure),
    };
    const presence = createPagePresence({
      isShared: () => true,
      localhost: true,
      channel: () => channel,
      jar: createFakeCookieJar(),
    });

    // When a sign-in sets the flag and a sign-out clears it
    await presence.set();
    await presence.clear();

    // Then each write is counted and left as a breadcrumb
    expect(metrics.counted('session.flag_write')).toEqual([
      { outcome: 'error', reason: 'set' },
      { outcome: 'error', reason: 'clear' },
    ]);
    expect(captures.expected).toHaveBeenCalledWith(failure, { flow: 'wallet', step: 'presence_set' });
    expect(captures.expected).toHaveBeenCalledWith(failure, { flow: 'wallet', step: 'presence_clear' });
    expect(captures.exception).not.toHaveBeenCalled();
  });
});

function createDeployedPresence(jar: CookieJar) {
  return createPagePresence({
    isShared: () => isFlagShared('page'),
    localhost: false,
    channel: getUnservedChannel,
    jar,
  });
}
