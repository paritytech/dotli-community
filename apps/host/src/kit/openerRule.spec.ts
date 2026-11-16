// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getOpenerParty, getSessionOpenerVerdict, type OpenerParty } from './openerRule.js';

const FIRST: OpenerParty = { party: 'first' };
const THIRD: OpenerParty = { party: 'third' };

/** The party of an opener refused with `verdict`. */
function createRefusal(verdict: Extract<OpenerParty, { party: null }>['verdict']): OpenerParty {
  return { party: null, verdict };
}

describe('the openers a session window serves', () => {
  it.each(['https://browse.dot.li', 'https://dot.li'])(
    'As a user in the sign-in window, I open it from %s and the opener is accepted',
    opener => {
      // Given the window on the root domain
      const self = 'https://dot.li';

      // When the opener is checked
      const verdict = getSessionOpenerVerdict(opener, self);

      // Then the root domain and its subdomains pass
      expect(verdict).toBe('allowed');
    },
  );

  it.each([
    'https://x.app.dot.li',
    'https://app.dot.li',
    'http://browse.dot.li',
    'https://evil.li',
    'https://notdot.li',
    'https://dot.li.evil.com',
    'http://localhost:4321',
    'https://dot.li:8443',
    'https://browse.dot.li:9999',
    'https://user@dot.li',
    'https://dot.li/x',
    'not a url',
    '',
  ])('As a user in the sign-in window, I open it from %s and the opener is refused', opener => {
    // Given the window on the root domain
    const self = 'https://dot.li';

    // When the opener is checked
    const verdict = getSessionOpenerVerdict(opener, self);

    // Then the product origins and foreign origins fail
    expect(verdict).not.toBe('allowed');
  });

  it.each(['http://localhost:4321', 'http://browse.localhost:4321'])(
    'As a user in the sign-in window on localhost, I open it from %s, a localhost page or a dev subdomain on its port, and the opener is accepted',
    opener => {
      // Given the window on localhost
      const self = 'http://localhost:4321';

      // When the opener is checked
      const verdict = getSessionOpenerVerdict(opener, self);

      // Then it passes
      expect(verdict).toBe('allowed');
    },
  );

  it.each(['http://localhost:1', 'https://localhost:4321', 'http://app.localhost:4321', 'http://x.app.localhost:4321'])(
    'As a user in the sign-in window on localhost, I open it from %s and the opener is refused',
    opener => {
      // Given the window on localhost
      const self = 'http://localhost:4321';

      // When an opener with another port, protocol or an app origin is checked
      const verdict = getSessionOpenerVerdict(opener, self);

      // Then it fails
      expect(verdict).not.toBe('allowed');
    },
  );

  it.each(['https://local.host:4321', 'https://browse.local.host:4321'])(
    'As a user in the sign-in window on local.host, I open it from %s on its protocol and port and the opener is accepted',
    opener => {
      // Given the window on local.host
      const self = 'https://local.host:4321';

      // When an opener on local.host or a dev subdomain of it is checked
      const verdict = getSessionOpenerVerdict(opener, self);

      // Then it passes
      expect(verdict).toBe('allowed');
    },
  );

  it.each([
    'https://local.host:1',
    'http://browse.local.host:4321',
    'https://app.local.host:4321',
    'https://x.app.local.host:4321',
    'https://localhost:4321',
    'https://browse.localhost:4321',
  ])('As a user in the sign-in window on local.host, I open it from %s and the opener is refused', opener => {
    // Given the window on local.host
    const self = 'https://local.host:4321';

    // When an opener with another port, protocol, an app origin or another local root is checked
    const verdict = getSessionOpenerVerdict(opener, self);

    // Then it fails
    expect(verdict).not.toBe('allowed');
  });
});

describe('why a session window refuses an opener', () => {
  it.each([
    ['https://browse.dot.li', 'https://dot.li', 'allowed'],
    ['https://x.app.dot.li', 'https://dot.li', 'app'],
    ['http://browse.dot.li', 'https://dot.li', 'insecure'],
    ['https://browse.dot.li:9999', 'https://dot.li', 'port'],
    ['https://evil.li', 'https://dot.li', 'foreign'],
    ['http://localhost:4321', 'https://dot.li', 'localhost'],
    ['not a url', 'https://dot.li', 'malformed'],
    ['https://user@dot.li', 'https://dot.li', 'malformed'],
    ['https://x.app.dot.li.', 'https://dot.li', 'malformed'],
    ['https://example.com.', 'https://dot.li', 'malformed'],
    ['http://localhost:4321', 'http://localhost:4321', 'allowed'],
    ['http://x.app.localhost:4321', 'http://localhost:4321', 'app'],
    ['http://localhost:5189', 'http://localhost:4321', 'port'],
    ['https://localhost:4321', 'http://localhost:4321', 'insecure'],
    ['https://dot.li', 'http://localhost:4321', 'foreign'],
    ['https://browse.local.host:4321', 'https://local.host:4321', 'allowed'],
    ['https://x.app.local.host:4321', 'https://local.host:4321', 'app'],
    ['https://browse.localhost:4321', 'https://local.host:4321', 'foreign'],
    ['https://browse.local.host:4321', 'https://localhost:4321', 'foreign'],
    ['https://browse.local.host:4321', 'https://dot.li', 'localhost'],
  ])('As an operator, I see %s judged against %s and the verdict is %s', (opener, self, verdict) => {
    // Given the row's opener origin and the window's own
    const origins = { opener, self };

    // When the opener is judged against the window's origin
    const judged = getSessionOpenerVerdict(origins.opener, origins.self);

    // Then the verdict is one of a closed set, whatever the opener sent
    expect(judged).toBe(verdict);
  });
});

describe("the party of a session window's opener", () => {
  it.each<[string, string, string, OpenerParty]>([
    ['a first-party page', 'https://browse.dot.li', 'https://dot.li', FIRST],
    ['the root domain', 'https://dot.li', 'https://dot.li', FIRST],
    ['a sandbox origin', 'https://x.app.dot.li', 'https://dot.li', createRefusal('app')],
    ['a sandbox origin on another port', 'https://x.app.dot.li:8443', 'https://dot.li', createRefusal('port')],
    ['a site', 'https://example.com', 'https://dot.li', THIRD],
    ['a site on another port', 'https://example.com:8443', 'https://dot.li', THIRD],
    ['a site on a local window', 'https://example.com', 'http://localhost:4321', THIRD],
    ['a localhost page', 'http://localhost:3000', 'https://dot.li', THIRD],
    ['a localhost page over https', 'https://localhost:3000', 'https://dot.li', THIRD],
    ['a localhost page on another port', 'http://localhost:3000', 'http://localhost:4321', THIRD],
    ['the window itself', 'http://localhost:4321', 'http://localhost:4321', FIRST],
    ['a dev subdomain on another port', 'http://browse.localhost:3000', 'http://localhost:4321', createRefusal('port')],
    [
      'a dev subdomain of local.host on another port',
      'https://browse.local.host:9999',
      'https://local.host:4321',
      createRefusal('port'),
    ],
    ['an insecure site', 'http://evil.example', 'https://dot.li', createRefusal('insecure')],
    ['an insecure site on a local window', 'http://evil.example', 'http://localhost:4321', createRefusal('foreign')],
    ['an insecure page under the root domain', 'http://sub.dot.li', 'https://dot.li', createRefusal('insecure')],
    [
      'a page under the root domain on another port',
      'https://sub.dot.li:8443',
      'https://dot.li',
      createRefusal('port'),
    ],
    ['a malformed origin', 'not a url', 'https://dot.li', createRefusal('malformed')],
    ['an origin with a path', 'https://example.com/x', 'https://dot.li', createRefusal('malformed')],
    ['a sandbox origin with a trailing dot', 'https://x.app.dot.li.', 'https://dot.li', createRefusal('malformed')],
    ['a site with a trailing dot', 'https://example.com.', 'https://dot.li', createRefusal('malformed')],
  ])(
    "As a user, I see a session window opened by %s (%s against %s) and it names the opener's party",
    (_name, opener, self, party) => {
      // Given the row's opener origin and the window's own
      const origins = { opener, self };

      // When the opener's party is judged
      const judged = getOpenerParty(origins.opener, origins.self);

      // Then it is first, third, or refused with the verdict an operator sees
      expect(judged).toEqual(party);
    },
  );
});
