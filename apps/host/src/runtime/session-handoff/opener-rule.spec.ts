// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { openerParty, sessionOpenerVerdict, type OpenerParty } from './opener-rule.js';

describe('sessionOpenerVerdict, the openers served', () => {
  it.each(['https://browse.dot.li', 'https://dot.li'])(
    'As a user in the sign-in window, I open it from %s and the opener is accepted',
    opener => {
      // Given the window on the root domain
      // When the opener is checked
      // Then the root domain and its subdomains pass
      expect(sessionOpenerVerdict(opener, 'https://dot.li')).toBe('allowed');
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
    // When the opener is checked
    // Then the product origins and foreign origins fail
    expect(sessionOpenerVerdict(opener, 'https://dot.li')).not.toBe('allowed');
  });

  it('As a user in the sign-in window on localhost, I open it from a localhost page and the opener is accepted', () => {
    // Given the window on localhost
    // When a localhost opener is checked
    // Then it passes
    expect(sessionOpenerVerdict('http://localhost:4321', 'http://localhost:4321')).toBe('allowed');
  });

  it('As a user in the sign-in window on localhost, I open it from a dev subdomain on its port and the opener is accepted', () => {
    // Given the window on localhost
    // When a <label>.localhost opener on the same port is checked
    // Then it passes
    expect(sessionOpenerVerdict('http://browse.localhost:4321', 'http://localhost:4321')).toBe('allowed');
  });

  it.each(['http://localhost:1', 'https://localhost:4321', 'http://app.localhost:4321', 'http://x.app.localhost:4321'])(
    'As a user in the sign-in window on localhost, I open it from %s and the opener is refused',
    opener => {
      // Given the window on localhost
      // When an opener with another port, protocol or an app origin is checked
      // Then it fails
      expect(sessionOpenerVerdict(opener, 'http://localhost:4321')).not.toBe('allowed');
    },
  );

  it.each(['https://local.host:4321', 'https://browse.local.host:4321'])(
    'As a user in the sign-in window on local.host, I open it from %s on its protocol and port and the opener is accepted',
    opener => {
      // Given the window on local.host
      // When an opener on local.host or a dev subdomain of it is checked
      // Then it passes
      expect(sessionOpenerVerdict(opener, 'https://local.host:4321')).toBe('allowed');
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
    // When an opener with another port, protocol, an app origin or another local root is checked
    // Then it fails
    expect(sessionOpenerVerdict(opener, 'https://local.host:4321')).not.toBe('allowed');
  });
});

describe('sessionOpenerVerdict, each refusal', () => {
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
  ])('As an operator, I see why %s is judged against %s: %s', (opener, self, verdict) => {
    // Given the row's opener origin and the window's own
    const origins = { opener, self };

    // When the opener is judged against the window's origin
    const judged = sessionOpenerVerdict(origins.opener, origins.self);

    // Then the verdict is one of a closed set, whatever the opener sent
    expect(judged).toBe(verdict);
  });
});

const FIRST: OpenerParty = { party: 'first' };
const THIRD: OpenerParty = { party: 'third' };
const refused = (verdict: Extract<OpenerParty, { party: null }>['verdict']): OpenerParty => ({
  party: null,
  verdict,
});

describe('openerParty', () => {
  it.each<[string, string, string, OpenerParty]>([
    ['a first-party page', 'https://browse.dot.li', 'https://dot.li', FIRST],
    ['the root domain', 'https://dot.li', 'https://dot.li', FIRST],
    ['a sandbox origin', 'https://x.app.dot.li', 'https://dot.li', refused('app')],
    ['a sandbox origin on another port', 'https://x.app.dot.li:8443', 'https://dot.li', refused('port')],
    ['a site', 'https://example.com', 'https://dot.li', THIRD],
    ['a site on another port', 'https://example.com:8443', 'https://dot.li', THIRD],
    ['a site on a local window', 'https://example.com', 'http://localhost:4321', THIRD],
    ['a localhost page', 'http://localhost:3000', 'https://dot.li', THIRD],
    ['a localhost page over https', 'https://localhost:3000', 'https://dot.li', THIRD],
    ['a localhost page on another port', 'http://localhost:3000', 'http://localhost:4321', THIRD],
    ['the window itself', 'http://localhost:4321', 'http://localhost:4321', FIRST],
    ['a dev subdomain on another port', 'http://browse.localhost:3000', 'http://localhost:4321', refused('port')],
    [
      'a dev subdomain of local.host on another port',
      'https://browse.local.host:9999',
      'https://local.host:4321',
      refused('port'),
    ],
    ['an insecure site', 'http://evil.example', 'https://dot.li', refused('insecure')],
    ['an insecure site on a local window', 'http://evil.example', 'http://localhost:4321', refused('foreign')],
    ['an insecure page under the root domain', 'http://sub.dot.li', 'https://dot.li', refused('insecure')],
    ['a page under the root domain on another port', 'https://sub.dot.li:8443', 'https://dot.li', refused('port')],
    ['a malformed origin', 'not a url', 'https://dot.li', refused('malformed')],
    ['an origin with a path', 'https://example.com/x', 'https://dot.li', refused('malformed')],
    ['a sandbox origin with a trailing dot', 'https://x.app.dot.li.', 'https://dot.li', refused('malformed')],
    ['a site with a trailing dot', 'https://example.com.', 'https://dot.li', refused('malformed')],
  ])('As a session window, I judge %s (%s against %s) and name its party', (_name, opener, self, party) => {
    // Given the row's opener origin and the window's own
    const origins = { opener, self };

    // When the opener's party is judged
    const judged = openerParty(origins.opener, origins.self);

    // Then it is first, third, or refused with the verdict an operator sees
    expect(judged).toEqual(party);
  });
});
