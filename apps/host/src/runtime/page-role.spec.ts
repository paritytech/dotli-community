// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  createPageRoleSlot,
  forgetsSiteGrants,
  loadReader,
  offersResume,
  ownsFlag,
  pairsOnly,
  sharesFlag,
  shellPageRole,
  showsSession,
  signInSurface,
  type PageRole,
} from './page-role.js';

/** Everything a role supplies, read in one go. */
function supplied(role: PageRole) {
  return {
    signIn: signInSurface(role),
    sharesFlag: sharesFlag(role),
    ownsFlag: ownsFlag(role),
    pairsOnly: pairsOnly(role),
    reader: loadReader(role),
    showsSession: showsSession(role),
    offersResume: offersResume(role),
    forgetsSiteGrants: forgetsSiteGrants(role),
  };
}

describe('page role', () => {
  it('As a user on a preview its preview host frames, I sign in on the page and the root domain flag stays alone', () => {
    // Given a preview route inside its preview host's frame
    const route = { kind: 'preview' } as const;
    const framed = true;

    // When the boot picks the page's role
    const role = shellPageRole(route, framed);

    // Then the page pairs in place and neither shares nor owns the flag
    expect(role).toBe('framed-preview');
    expect(supplied(role)).toEqual({
      signIn: 'in-page',
      sharesFlag: false,
      ownsFlag: false,
      pairsOnly: false,
      reader: 'load',
      showsSession: true,
      offersResume: false,
      forgetsSiteGrants: false,
    });
  });

  it('As a user on a preview opened on its own where the opener policy cuts any window, I sign in on the page and it raises the shared flag', () => {
    // Given a preview route in a tab of its own
    const route = { kind: 'preview' } as const;
    const framed = false;

    // When the boot picks the page's role
    const role = shellPageRole(route, framed);

    // Then the page pairs in place and owns the shared flag
    expect(role).toBe('preview');
    expect(supplied(role)).toEqual({
      signIn: 'in-page',
      sharesFlag: true,
      ownsFlag: true,
      pairsOnly: false,
      reader: 'load',
      showsSession: true,
      offersResume: false,
      forgetsSiteGrants: true,
    });
  });

  it('As a user on the landing page whose copy is the main store, I sign in on the page and it raises the shared flag and offers no sign-in made elsewhere', () => {
    // Given the landing page's role
    const role: PageRole = 'landing';

    // When the boot reads what the role supplies
    const supplies = supplied(role);

    // Then the page pairs in place, owns the flag and offers no resume
    expect(supplies).toEqual({
      signIn: 'in-page',
      sharesFlag: true,
      ownsFlag: true,
      pairsOnly: false,
      reader: 'load',
      showsSession: true,
      offersResume: false,
      forgetsSiteGrants: true,
    });
  });

  it('As a user on a product or on the shell on its way to the landing page, I sign in through the sign-in window and a sign-in made elsewhere is offered to resume', () => {
    // Given a product route and a landing route the shell is leaving, neither framed
    const productRoute = { kind: 'product' } as const;
    const landingRoute = { kind: 'landing' } as const;

    // When the boot picks each page's role
    const product = shellPageRole(productRoute, false);
    const leaving = shellPageRole(landingRoute, false);

    // Then both are product pages that sign in through the window and offer a resume
    expect([product, leaving]).toEqual(['page', 'page']);
    expect(supplied('page')).toEqual({
      signIn: 'window',
      sharesFlag: true,
      ownsFlag: false,
      pairsOnly: false,
      reader: 'load',
      showsSession: true,
      offersResume: true,
      forgetsSiteGrants: false,
    });
  });

  it('As a user in the sign-in window, I sign in on that page with no sign-in modal and only by pairing, and each sign-in it stores raises the flag', () => {
    // Given a window opened to sign in
    const role = 'signin-window' as const;

    // When the window boots with the sign-in window's role
    const supplies = supplied(role);

    // Then the window signs in itself, only pairs and owns the flag
    expect(supplies).toEqual({
      signIn: 'self',
      sharesFlag: true,
      ownsFlag: true,
      pairsOnly: true,
      reader: 'window',
      showsSession: true,
      offersResume: false,
      forgetsSiteGrants: false,
    });
  });

  it('As a user in the sign-out window, I see no sign-in modal and no session, and the window only pairs and raises no flag', () => {
    // Given a window opened to sign out
    const role = 'signout-window' as const;

    // When the window boots with the sign-out window's role
    const supplies = supplied(role);

    // Then the window only pairs, owns no flag and shows no session
    expect(supplies).toEqual({
      signIn: 'self',
      sharesFlag: true,
      ownsFlag: false,
      pairsOnly: true,
      reader: 'window',
      showsSession: false,
      offersResume: false,
      forgetsSiteGrants: false,
    });
  });

  it('As a user signing out in place on a page that owns the main store, I sign out and my signed-in sites are forgotten, while the sign-in window that also owns the flag never forgets them', () => {
    // Given every role a page may take
    const roles: PageRole[] = ['page', 'landing', 'preview', 'framed-preview', 'signin-window', 'signout-window'];

    // When each role says whether its sign-out forgets the grants
    const forgets = roles.filter(forgetsSiteGrants);

    // Then only the pages that pair in place in the main store forget them, and the sign-out window the rest
    expect(forgets).toEqual(['landing', 'preview']);
  });

  it('As an operator, I choose a page role a second time and the same role changes nothing while another role is a wiring fault', () => {
    // Given a slot the boot chose the framed preview role in
    const slot = createPageRoleSlot();
    slot.choose('framed-preview');

    // When the same role is chosen again and another is tried
    slot.choose('framed-preview');
    const other = (): void => {
      slot.choose('page');
    };

    // Then the other role throws and the first stays
    expect(other).toThrow('Page role page chosen after framed-preview');
    expect(slot.read()).toBe('framed-preview');
  });

  it('As an operator, I read the page role before the boot chose it and am told it is wired wrong', () => {
    // Given a slot no boot chose a role in
    const slot = createPageRoleSlot();

    // When the role is read
    const read = (): PageRole => slot.read();

    // Then the read throws
    expect(read).toThrow('Page role read before the boot chose it');
  });
});
