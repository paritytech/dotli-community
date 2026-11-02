// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import {
  createCookiePresence,
  listenForCookieFlagChange,
  type CookieChanges,
  type CookieJar,
} from './createCookiePresence.js';
import { createFakeCookieJar } from './createCookiePresence.fake.js';
import type { Presence } from './types.js';

const DOMAIN = 'dot.li';

const blockedJar: CookieJar = { read: () => '', write: () => undefined };

describe('cookie presence', () => {
  it.each<{ story: string; createJar: () => CookieJar; writes: ('set' | 'clear')[]; expected: Presence }>([
    { story: 'on a page, I set the flag', createJar: createFakeCookieJar, writes: ['set'], expected: 'present' },
    {
      story: 'on a page before any sign-in, I write no flag',
      createJar: createFakeCookieJar,
      writes: [],
      expected: 'absent',
    },
    {
      story: 'on a page, I set and clear the flag',
      createJar: createFakeCookieJar,
      writes: ['set', 'clear'],
      expected: 'absent',
    },
    {
      story: 'whose cookies are blocked, I set the flag',
      createJar: () => blockedJar,
      writes: ['set'],
      expected: 'unknown',
    },
  ])('As a user $story, then read it and get $expected', async ({ createJar, writes, expected }) => {
    // Given a cookie flag on the row's jar, with the row's writes made
    const presence = createCookiePresence({ jar: createJar(), domain: DOMAIN });
    for (const write of writes) {
      void presence[write]();
    }

    // When the flag is read
    const read = await presence.read();

    // Then it reads as the row expects
    expect(read).toBe(expected);
  });

  it('As a user on a page, I read the flag three times and it is probed once', async () => {
    // Given a cookie flag on a working jar
    const jar = createFakeCookieJar();
    const presence = createCookiePresence({ jar, domain: DOMAIN });

    // When the flag is read three times
    await presence.read();
    await presence.read();
    await presence.read();

    // Then one probe cookie was written
    expect(jar.written.filter(cookie => cookie.endsWith('Max-Age=60'))).toHaveLength(1);
  });

  it('As a user on a page, I read the flag among lookalike cookies and only the exact name counts', async () => {
    // Given a jar holding cookies whose names only resemble the flag
    const cookies: string[] = ['x_has_session=1', 'has_session_probe=1'];
    const jar: CookieJar = {
      read: () => cookies.join('; '),
      // The leftover probe cookie is what lets the probe read back.
      write: () => undefined,
    };
    const presence = createCookiePresence({ jar, domain: DOMAIN });

    // When the flag is read among the lookalikes, then the real cookie appears and the flag is read again
    const lookalikes = await presence.read();
    cookies.splice(1, 0, 'has_session=1');
    const real = await presence.read();

    // Then the lookalikes read absent and the real cookie present
    expect([lookalikes, real]).toEqual(['absent', 'present']);
  });

  it('As a user whose cookies were blocked at first, I read a missing cookie later and still get unknown for the rest of the page', async () => {
    // Given a jar that blocks cookies at first
    const inner = createFakeCookieJar();
    let blocked = true;
    const jar: CookieJar = {
      read: () => inner.read(),
      write(cookie) {
        if (!blocked) {
          inner.write(cookie);
        }
      },
    };
    const presence = createCookiePresence({ jar, domain: DOMAIN });

    // When the flag is read while the jar blocks, then the jar starts working and the flag is set, read, cleared and
    // read again
    const whileBlocked = await presence.read();
    blocked = false;
    void presence.set();
    const afterSet = await presence.read();
    void presence.clear();
    const afterClear = await presence.read();

    // Then it reads unknown while blocked, a cookie that is there reads present, and one that is not still reads unknown
    expect([whileBlocked, afterSet, afterClear]).toEqual(['unknown', 'present', 'unknown']);
  });

  it('As a signed-in user, I read the flag and no probe is written', async () => {
    // Given a cookie flag already set, with the written cookies forgotten
    const jar = createFakeCookieJar();
    const presence = createCookiePresence({ jar, domain: DOMAIN });
    void presence.set();
    jar.written.length = 0;

    // When the flag is read
    const read = await presence.read();

    // Then it reads present and no probe was written
    expect(read).toBe('present');
    expect(jar.written).toEqual([]);
  });

  it('As a user on a page, I set and clear the flag and both cookies carry the exact attributes', () => {
    // Given a cookie flag on a working jar
    const jar = createFakeCookieJar();
    const presence = createCookiePresence({ jar, domain: DOMAIN });

    // When the flag is set and cleared
    void presence.set();
    void presence.clear();

    // Then both cookies carry the exact domain, path and lifetime
    expect(jar.written).toEqual([
      'has_session=1; Domain=dot.li; Path=/; Secure; SameSite=Lax; Max-Age=34560000',
      'has_session=1; Domain=dot.li; Path=/; Secure; SameSite=Lax; Max-Age=0',
    ]);
  });

  it('As a user renewing the flag, I renew after it was deleted and it stays absent', async () => {
    // Given a working jar without the flag, as after a sign-out elsewhere
    const jar = createFakeCookieJar();
    const presence = createCookiePresence({ jar, domain: DOMAIN });

    // When the flag is renewed
    await presence.renew();

    // Then nothing was written
    expect(jar.written).toEqual([]);
  });

  it('As a user renewing the flag, I renew while it is set and it is extended', async () => {
    // Given a jar that holds the flag, with the written cookies forgotten
    const jar = createFakeCookieJar();
    jar.write(`has_session=1; Domain=${DOMAIN}; Path=/; Secure; SameSite=Lax; Max-Age=60`);
    jar.written.length = 0;
    const presence = createCookiePresence({ jar, domain: DOMAIN });

    // When the flag is renewed
    await presence.renew();

    // Then the flag was written again with its full lifetime
    expect(jar.written).toEqual(['has_session=1; Domain=dot.li; Path=/; Secure; SameSite=Lax; Max-Age=34560000']);
  });

  it('As a user on a page, I read the flag and the probe is a short-lived cookie deleted again', async () => {
    // Given a cookie flag on a working jar
    const jar = createFakeCookieJar();
    const presence = createCookiePresence({ jar, domain: DOMAIN });

    // When the flag is read
    await presence.read();

    // Then a short-lived probe was written and deleted again
    expect(jar.written).toEqual([
      'has_session_probe=1; Domain=dot.li; Path=/; Secure; SameSite=Lax; Max-Age=60',
      'has_session_probe=1; Domain=dot.li; Path=/; Secure; SameSite=Lax; Max-Age=0',
    ]);
  });
});

describe('listenForCookieFlagChange', () => {
  it('As a user with the page open, I watch the flag and hear it appear and disappear but not other cookies', () => {
    // Given a listener for flag changes
    const changes = createFakeCookieChanges();
    const listener = vi.fn();
    const stop = listenForCookieFlagChange(changes, listener);

    // When the flag and other cookies change and the listener stops before one more change
    changes.fire(['has_session']);
    changes.fire(['other']);
    changes.fire(['other', 'has_session']);
    stop();
    changes.fire(['has_session']);

    // Then only the two flag changes before the stop were heard
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('As a user in a browser without cookie change events, I watch the flag and stop safely with nothing heard', () => {
    // Given a listener for flag changes
    const listener = vi.fn();

    // When the browser has no cookie change events and the listener stops
    const stop = listenForCookieFlagChange(null, listener);
    stop();

    // Then nothing was heard
    expect(listener).not.toHaveBeenCalled();
  });
});

/** Cookie change events a spec fires by hand. */
function createFakeCookieChanges(): CookieChanges & { fire: (names: string[]) => void } {
  const listeners = new Set<(names: readonly string[]) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return unsubscribe;

      function unsubscribe(): void {
        listeners.delete(listener);
      }
    },
    fire(names) {
      for (const listener of listeners) {
        listener(names);
      }
    },
  };
}
