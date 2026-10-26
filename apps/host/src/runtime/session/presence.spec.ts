// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { deferred } from '@dotli/shared';
import { bindCaptureSink } from '@dotli/metrics';
import { bindRecordingSentry } from '@dotli/metrics/testing';
import type { SharedChannel } from '../shared-mode.js';
import {
  createCookiePresence,
  createPagePresence,
  createStorePresence,
  onCookieFlagChange,
  type CookieChanges,
  type CookieJar,
  type SessionPresence,
} from './presence.js';
import { sharesFlag } from '../page-role.js';

const DOMAIN = 'dot.li';

/** A jar that stores by name and honours `Max-Age=0`, and records every written string. */
function memoryJar(): CookieJar & { written: string[]; reads: () => number } {
  const cookies = new Map<string, string>();
  const written: string[] = [];
  let reads = 0;
  return {
    written,
    reads: () => reads,
    read: () => {
      reads += 1;
      return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    write: cookie => {
      written.push(cookie);
      const [pair = '', ...attributes] = cookie.split('; ');
      const [name = '', value = ''] = pair.split('=');
      if (attributes.includes('Max-Age=0')) {
        cookies.delete(name);
      } else {
        cookies.set(name, value);
      }
    },
  };
}

const blockedJar: CookieJar = { read: () => '', write: () => undefined };

const failingChannel = (): SharedChannel => {
  throw new Error('no dev store on a deployed page');
};

describe('cookie presence', () => {
  it('As a page, I read present after set', async () => {
    // Given a cookie flag on a working jar
    const presence = createCookiePresence(memoryJar(), DOMAIN);

    // When the flag is set
    void presence.set();

    // Then it reads present
    expect(await presence.read()).toBe('present');
  });

  it('As a page, I read absent before any sign-in and after clear', async () => {
    // Given a cookie flag that reads absent before any sign-in
    const presence = createCookiePresence(memoryJar(), DOMAIN);
    expect(await presence.read()).toBe('absent');

    // When the flag is set and cleared
    void presence.set();
    void presence.clear();

    // Then it reads absent
    expect(await presence.read()).toBe('absent');
  });

  it('As a page whose cookies are blocked, I read unknown', async () => {
    // Given a cookie flag on a jar that blocks cookies
    const presence = createCookiePresence(blockedJar, DOMAIN);

    // When the flag is set
    void presence.set();

    // Then it reads unknown
    expect(await presence.read()).toBe('unknown');
  });

  it('As a page, I probe once however often I read', async () => {
    // Given a cookie flag on a working jar
    const jar = memoryJar();
    const presence = createCookiePresence(jar, DOMAIN);

    // When the flag is read three times
    await presence.read();
    await presence.read();
    await presence.read();

    // Then one probe cookie was written
    expect(jar.written.filter(cookie => cookie.endsWith('Max-Age=60'))).toHaveLength(1);
  });

  it('As a page, I read only the exact cookie name out of several cookies', async () => {
    // Given a jar holding cookies whose names only resemble the flag
    const cookies: string[] = ['x_has_session=1', 'has_session_probe=1'];
    const jar: CookieJar = {
      read: () => cookies.join('; '),
      // The leftover probe cookie is what lets the probe read back.
      write: () => undefined,
    };
    const presence = createCookiePresence(jar, DOMAIN);

    // When the flag is read, then the real cookie appears
    const lookalikes = await presence.read();
    cookies.splice(1, 0, 'has_session=1');

    // Then the lookalikes read absent and the real cookie present
    expect(lookalikes).toBe('absent');
    expect(await presence.read()).toBe('present');
  });

  it('As a page whose cookies were blocked at first, I read a missing cookie as unknown for the rest of the page', async () => {
    // Given a jar that blocks cookies at first
    const inner = memoryJar();
    let blocked = true;
    const jar: CookieJar = {
      read: () => inner.read(),
      write: cookie => {
        if (!blocked) {
          inner.write(cookie);
        }
      },
    };
    const presence = createCookiePresence(jar, DOMAIN);
    expect(await presence.read()).toBe('unknown');

    // When the jar starts working and the flag is set, read and cleared
    blocked = false;
    void presence.set();
    const set = await presence.read();
    void presence.clear();

    // Then a cookie that is there reads present, and one that is not still reads unknown
    expect(set).toBe('present');
    expect(await presence.read()).toBe('unknown');
  });

  it('As a signed-in page, I read the cookie without writing a probe', async () => {
    // Given a cookie flag already set, with the written cookies forgotten
    const jar = memoryJar();
    const presence = createCookiePresence(jar, DOMAIN);
    void presence.set();
    jar.written.length = 0;

    // When the flag is read
    const read = await presence.read();

    // Then it reads present and no probe was written
    expect(read).toBe('present');
    expect(jar.written).toEqual([]);
  });

  it('As a page, I write the cookie with the exact attributes', () => {
    // Given a cookie flag on a working jar
    const jar = memoryJar();
    const presence = createCookiePresence(jar, DOMAIN);

    // When the flag is set and cleared
    void presence.set();
    void presence.clear();

    // Then both cookies carry the exact domain, path and lifetime
    expect(jar.written).toEqual([
      'has_session=1; Domain=dot.li; Path=/; Secure; SameSite=Lax; Max-Age=34560000',
      'has_session=1; Domain=dot.li; Path=/; Secure; SameSite=Lax; Max-Age=0',
    ]);
  });

  it('As a page renewing the flag, I leave it absent when it was deleted before my renew', async () => {
    // Given a working jar without the flag, as after a sign-out elsewhere
    const jar = memoryJar();
    const presence = createCookiePresence(jar, DOMAIN);

    // When the flag is renewed
    await presence.renew();

    // Then nothing was written
    expect(jar.written).toEqual([]);
  });

  it('As a page renewing the flag, I extend it when it is set', async () => {
    // Given a jar that holds the flag, with the written cookies forgotten
    const jar = memoryJar();
    jar.write(`has_session=1; Domain=${DOMAIN}; Path=/; Secure; SameSite=Lax; Max-Age=60`);
    jar.written.length = 0;
    const presence = createCookiePresence(jar, DOMAIN);

    // When the flag is renewed
    await presence.renew();

    // Then the flag was written again with its full lifetime
    expect(jar.written).toEqual(['has_session=1; Domain=dot.li; Path=/; Secure; SameSite=Lax; Max-Age=34560000']);
  });

  it('As a page, I probe with a short-lived cookie that I delete again', async () => {
    // Given a cookie flag on a working jar
    const jar = memoryJar();
    const presence = createCookiePresence(jar, DOMAIN);

    // When the flag is read
    await presence.read();

    // Then a short-lived probe was written and deleted again
    expect(jar.written).toEqual([
      'has_session_probe=1; Domain=dot.li; Path=/; Secure; SameSite=Lax; Max-Age=60',
      'has_session_probe=1; Domain=dot.li; Path=/; Secure; SameSite=Lax; Max-Age=0',
    ]);
  });
});

function memoryChannel(failing = false): SharedChannel {
  const values = new Map<string, string>();
  const fail = (): Promise<never> => Promise.reject(new Error('dev store down'));
  return {
    read: key => (failing ? fail() : Promise.resolve(values.get(key) ?? null)),
    write: (key, value) => {
      if (failing) {
        return fail();
      }
      values.set(key, value);
      return Promise.resolve();
    },
    clear: key => {
      values.delete(key);
      return Promise.resolve();
    },
  };
}

describe('store presence', () => {
  it('As a page in development, I read present after set and absent after clear', async () => {
    // Given a flag over a working dev store
    const presence = createStorePresence(memoryChannel());

    // When the flag is set, read and cleared
    void presence.set();
    const afterSet = await presence.read();
    void presence.clear();

    // Then it read present after the set and absent after the clear
    expect(afterSet).toBe('present');
    expect(await presence.read()).toBe('absent');
  });

  it('As a page in development, I renew a flag the dev store holds and send nothing', async () => {
    // Given a dev store that holds the flag and records every read, write and clear
    const sent: string[] = [];
    const channel: SharedChannel = {
      read: key => {
        sent.push(`read ${key}`);
        return Promise.resolve('1');
      },
      write: key => {
        sent.push(`write ${key}`);
        return Promise.resolve();
      },
      clear: key => {
        sent.push(`clear ${key}`);
        return Promise.resolve();
      },
    };

    // When the flag is renewed
    await createStorePresence(channel).renew();

    // Then nothing was sent
    expect(sent).toEqual([]);
  });
});

describe('guarded presence', () => {
  it('As a page whose flag read rejects, I read unknown and leave a breadcrumb for the restore to count', async () => {
    // Given a flag whose read rejects
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const failure = new Error('cookie blocked');
    const jar: CookieJar = {
      read: () => {
        throw failure;
      },
      write: () => undefined,
    };
    const presence = createPagePresence({ shared: () => true, localhost: false, channel: failingChannel, jar });

    // When the page reads it
    const result = await presence.read();

    // Then it reads unknown and the miss is a breadcrumb, not an issue
    expect(result).toBe('unknown');
    expect(captures.expected).toHaveBeenCalledWith(failure, { flow: 'wallet', step: 'presence_read' });
    expect(captures.exception).not.toHaveBeenCalled();
  });

  it('As a page whose flag write throws, I go on and the failure is counted', async () => {
    // Given a flag whose write throws
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    onTestFinished(bindCaptureSink({ exception: vi.fn(), expected: vi.fn() }));
    const jar: CookieJar = {
      read: () => '',
      write: () => {
        throw new Error('cookie blocked');
      },
    };
    const presence = createPagePresence({ shared: () => true, localhost: false, channel: failingChannel, jar });

    // When the page sets it
    await presence.set();

    // Then the failure is counted
    expect(metrics.counted('session.flag_write')).toEqual([{ outcome: 'error', reason: 'set' }]);
  });
});

describe('page presence', () => {
  it('As a page on a preview its preview host frames, I read my flag as unknown and never write it, even where cookies work', async () => {
    // Given a framed preview, whose sign-in sits in its preview host's partition, apart from the main store
    const jar = memoryJar();
    jar.write(`has_session=1; Domain=${DOMAIN}; Path=/; Secure; SameSite=Lax; Max-Age=60`);
    jar.written.length = 0;
    const presence = createPagePresence({
      shared: () => sharesFlag('framed-preview'),
      localhost: false,
      channel: failingChannel,
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

  it('As a deployed page or a preview tab or a window, I read and write the cookie', async () => {
    for (const role of ['page', 'preview', 'signin-window', 'signout-window'] as const) {
      // Given the page's flag for that role on a working jar
      const jar = memoryJar();
      const presence = createPagePresence({
        shared: () => sharesFlag(role),
        localhost: false,
        channel: failingChannel,
        jar,
      });

      // When the flag is set
      void presence.set();

      // Then it reads present
      expect(await presence.read()).toBe('present');
    }
  });

  it('As a deployed page, I renew my flag only while it is still set', async () => {
    // Given one page whose jar holds the flag and one whose flag a sign-out elsewhere deleted
    const held = memoryJar();
    held.write(`has_session=1; Domain=${DOMAIN}; Path=/; Secure; SameSite=Lax; Max-Age=60`);
    held.written.length = 0;
    const deleted = memoryJar();
    const pageOn = (jar: CookieJar): SessionPresence =>
      createPagePresence({ shared: () => sharesFlag('page'), localhost: false, channel: failingChannel, jar });

    // When each page renews its flag
    await pageOn(held).renew();
    await pageOn(deleted).renew();

    // Then only the flag still set was written again, with its full lifetime
    expect(held.written).toEqual(['has_session=1; Domain=dot.li; Path=/; Secure; SameSite=Lax; Max-Age=34560000']);
    expect(deleted.written).toEqual([]);
  });

  it('As a page in development, I read unknown when the dev store fails', async () => {
    // Given a flag over a dev store that fails
    const captures = { exception: vi.fn(), expected: vi.fn() };
    onTestFinished(bindCaptureSink(captures));
    const presence = createPagePresence({
      shared: () => true,
      localhost: true,
      channel: () => memoryChannel(true),
      jar: blockedJar,
    });

    // When the flag is read
    const result = await presence.read();

    // Then it reads unknown and the miss is a breadcrumb
    expect(result).toBe('unknown');
    expect(captures.expected).toHaveBeenCalledWith(expect.any(Error), { flow: 'wallet', step: 'presence_read' });
    expect(captures.exception).not.toHaveBeenCalled();
  });

  it('As a page renewing the flag, I report a renew that fails and go on', async () => {
    // Given a jar that holds the flag and whose write throws
    const metrics = bindRecordingSentry({ onFinished: onTestFinished });
    onTestFinished(bindCaptureSink({ exception: vi.fn(), expected: vi.fn() }));
    const jar: CookieJar = {
      read: () => 'has_session=1',
      write: () => {
        throw new Error('cookie blocked');
      },
    };

    // When the flag is renewed
    const renewing = createPagePresence({ shared: () => true, localhost: false, channel: failingChannel, jar }).renew();

    // Then the renew resolves and its failure is counted
    await expect(renewing).resolves.toBeUndefined();
    expect(metrics.counted('session.flag_write')).toEqual([{ outcome: 'error', reason: 'renew' }]);
  });

  it('As a page that signs out, I clear my flag and the cookie is deleted in the same turn', () => {
    // Given a deployed page's flag on a working jar
    const jar = memoryJar();
    const presence = createPagePresence({ shared: () => true, localhost: false, channel: failingChannel, jar });

    // When the flag is cleared and nothing is awaited
    void presence.clear();

    // Then the cookie was already deleted
    expect(jar.written).toEqual(['has_session=1; Domain=dot.li; Path=/; Secure; SameSite=Lax; Max-Age=0']);
  });
});

describe('presence writes', () => {
  it('As a page in development, I write my flag and the write settles only once the dev store took it', async () => {
    // Given a dev store whose write is held
    const written = deferred<undefined>();
    const asked = deferred<undefined>();
    const writes: string[] = [];
    const channel: SharedChannel = {
      read: () => Promise.resolve(null),
      write: key => {
        writes.push(key);
        asked.resolve(undefined);
        return written.promise;
      },
      clear: () => Promise.resolve(),
    };
    let settled = false;

    // When the flag is set
    const presence = createPagePresence({
      shared: () => true,
      localhost: true,
      channel: () => channel,
      jar: blockedJar,
    });
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

  it('As a page served on localhost where nothing serves the dev store, I write my flag and each write settles as a breadcrumb and a count, not an issue', async () => {
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
      shared: () => true,
      localhost: true,
      channel: () => channel,
      jar: blockedJar,
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

/** Cookie change events a spec fires by hand. */
function fakeCookieChanges(): CookieChanges & { fire: (names: string[]) => void } {
  const listeners = new Set<(names: readonly string[]) => void>();
  return {
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    fire: names => {
      for (const listener of listeners) {
        listener(names);
      }
    },
  };
}

describe('onCookieFlagChange', () => {
  it('As an open page, I hear the flag cookie appear and disappear, and not other cookies', () => {
    // Given a listener for flag changes
    const changes = fakeCookieChanges();
    const listener = vi.fn();
    const stop = onCookieFlagChange(changes, listener);

    // When the flag and other cookies change, then the listener stops
    changes.fire(['has_session']);
    changes.fire(['other']);
    changes.fire(['other', 'has_session']);
    stop();
    changes.fire(['has_session']);

    // Then only the two flag changes before the stop were heard
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('As a page in a browser without cookie change events, I watch nothing and my stop is safe', () => {
    // Given a listener for flag changes
    const listener = vi.fn();

    // When the browser has no cookie change events and the listener stops
    const stop = onCookieFlagChange(null, listener);
    stop();

    // Then nothing was heard
    expect(listener).not.toHaveBeenCalled();
  });
});
