// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { catchError } from '@dotli/shared/testing';
import {
  createPageRoleSlot,
  isSiteGrantForgotten,
  getLoadReader,
  isResumeOffered,
  isFlagOwner,
  isPairingOnly,
  isFlagShared,
  getShellPageRole,
  isSessionShown,
  getSignInSurface,
  type PageRole,
} from './pageRole.js';

/** Everything a role supplies, read in one go. */
function readSupplies(role: PageRole) {
  return {
    signIn: getSignInSurface(role),
    isFlagShared: isFlagShared(role),
    isFlagOwner: isFlagOwner(role),
    isPairingOnly: isPairingOnly(role),
    reader: getLoadReader(role),
    isSessionShown: isSessionShown(role),
    isResumeOffered: isResumeOffered(role),
    isSiteGrantForgotten: isSiteGrantForgotten(role),
  };
}

describe('page role', () => {
  it('As a user on a preview its preview host frames, I sign in on the page and the root domain flag stays alone', () => {
    // Given a preview route inside its preview host's frame
    const route = { kind: 'preview' } as const;
    const framed = true;

    // When the boot picks the page's role and reads what it supplies
    const role = getShellPageRole(route, framed);
    const supplies = readSupplies(role);

    // Then the page pairs in place and neither shares nor owns the flag
    expect(role).toBe('framed-preview');
    expect(supplies).toEqual({
      signIn: 'in-page',
      isFlagShared: false,
      isFlagOwner: false,
      isPairingOnly: false,
      reader: 'load',
      isSessionShown: true,
      isResumeOffered: false,
      isSiteGrantForgotten: false,
    });
  });

  it('As a user on a preview opened on its own where the opener policy cuts any window, I sign in on the page and it raises the shared flag', () => {
    // Given a preview route in a tab of its own
    const route = { kind: 'preview' } as const;
    const framed = false;

    // When the boot picks the page's role and reads what it supplies
    const role = getShellPageRole(route, framed);
    const supplies = readSupplies(role);

    // Then the page pairs in place and owns the shared flag
    expect(role).toBe('preview');
    expect(supplies).toEqual({
      signIn: 'in-page',
      isFlagShared: true,
      isFlagOwner: true,
      isPairingOnly: false,
      reader: 'load',
      isSessionShown: true,
      isResumeOffered: false,
      isSiteGrantForgotten: true,
    });
  });

  it('As a user on the landing page whose copy is the main store, I sign in on the page and it raises the shared flag and offers no sign-in made elsewhere', () => {
    // Given the landing page's role
    const role: PageRole = 'landing';

    // When the boot reads what the role supplies
    const supplies = readSupplies(role);

    // Then the page pairs in place, owns the flag and offers no resume
    expect(supplies).toEqual({
      signIn: 'in-page',
      isFlagShared: true,
      isFlagOwner: true,
      isPairingOnly: false,
      reader: 'load',
      isSessionShown: true,
      isResumeOffered: false,
      isSiteGrantForgotten: true,
    });
  });

  it('As a user on a product or on the shell on its way to the landing page, I sign in through the sign-in window and a sign-in made elsewhere is offered to resume', () => {
    // Given a product route and a landing route the shell is leaving, neither framed
    const productRoute = { kind: 'product' } as const;
    const landingRoute = { kind: 'landing' } as const;

    // When the boot picks each page's role and reads what a product page supplies
    const product = getShellPageRole(productRoute, false);
    const leaving = getShellPageRole(landingRoute, false);
    const supplies = readSupplies('page');

    // Then both are product pages that sign in through the window and offer a resume
    expect([product, leaving]).toEqual(['page', 'page']);
    expect(supplies).toEqual({
      signIn: 'window',
      isFlagShared: true,
      isFlagOwner: false,
      isPairingOnly: false,
      reader: 'load',
      isSessionShown: true,
      isResumeOffered: true,
      isSiteGrantForgotten: false,
    });
  });

  it('As a user in the sign-in window, I sign in on that page with no sign-in modal and only by pairing, and each sign-in it stores raises the flag', () => {
    // Given a window opened to sign in
    const role = 'signin-window' as const;

    // When the window boots with the sign-in window's role
    const supplies = readSupplies(role);

    // Then the window signs in itself, only pairs and owns the flag
    expect(supplies).toEqual({
      signIn: 'self',
      isFlagShared: true,
      isFlagOwner: true,
      isPairingOnly: true,
      reader: 'window',
      isSessionShown: true,
      isResumeOffered: false,
      isSiteGrantForgotten: false,
    });
  });

  it('As a user in the sign-out window, I see no sign-in modal and no session, and the window only pairs and raises no flag', () => {
    // Given a window opened to sign out
    const role = 'signout-window' as const;

    // When the window boots with the sign-out window's role
    const supplies = readSupplies(role);

    // Then the window only pairs, owns no flag and shows no session
    expect(supplies).toEqual({
      signIn: 'self',
      isFlagShared: true,
      isFlagOwner: false,
      isPairingOnly: true,
      reader: 'window',
      isSessionShown: false,
      isResumeOffered: false,
      isSiteGrantForgotten: false,
    });
  });

  it('As an operator, I choose a page role a second time and the same role changes nothing while another role is a wiring fault', () => {
    // Given a slot the boot chose the framed preview role in
    const slot = createPageRoleSlot();
    slot.choose('framed-preview');

    // When the same role is chosen again and another is tried
    slot.choose('framed-preview');
    const error = catchError(() => {
      slot.choose('page');
    });
    const role = slot.get();

    // Then the other role throws and the first stays
    expect(error).toEqual(new Error('Page role page chosen after framed-preview'));
    expect(role).toBe('framed-preview');
  });

  it('As an operator, I read the page role before the boot chose it and am told it is wired wrong', () => {
    // Given a slot no boot chose a role in
    const slot = createPageRoleSlot();

    // When the role is read
    const error = catchError(() => slot.get());

    // Then the read throws
    expect(error).toEqual(new Error('Page role read before the boot chose it'));
  });
});
