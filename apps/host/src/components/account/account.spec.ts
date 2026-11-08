// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getAuthButtonState, type AccountSession, type AuthButtonFace, type AuthButtonState } from './account.js';
import type { SessionKnowledge } from '../../runtime/session/authViews.js';

const ALICE: AccountSession = { fullUsername: 'Alice Smith' };
const PROMPT: AuthButtonFace = { kind: 'prompt', resumes: false };
const RESUMING: AuthButtonFace = { kind: 'prompt', resumes: true };
const ALERT: AuthButtonFace = { kind: 'alert' };

type Row = {
  case: string;
  knowledge: SessionKnowledge;
  signingOut: boolean;
  loggedIn: boolean;
  elsewhere: boolean;
  session: AccountSession | undefined;
  expected: AuthButtonState;
};

const ROWS: Row[] = [
  {
    case: 'session is being read',
    knowledge: 'reading',
    signingOut: false,
    loggedIn: false,
    elsewhere: false,
    session: undefined,
    expected: { kind: 'checking', face: PROMPT },
  },
  {
    case: 'session is being read while a sign-out waits',
    knowledge: 'reading',
    signingOut: true,
    loggedIn: false,
    elsewhere: false,
    session: undefined,
    expected: { kind: 'checking', face: PROMPT },
  },
  {
    case: 'session is being read while a sign-in waits elsewhere',
    knowledge: 'reading',
    signingOut: false,
    loggedIn: false,
    elsewhere: true,
    session: undefined,
    expected: { kind: 'checking', face: RESUMING },
  },
  {
    case: 'saved sign-in cannot be reached',
    knowledge: 'unreachable',
    signingOut: false,
    loggedIn: false,
    elsewhere: false,
    session: undefined,
    expected: { kind: 'unreachable', face: ALERT, busy: false },
  },
  {
    case: 'saved sign-in cannot be reached while a sign-out waits',
    knowledge: 'unreachable',
    signingOut: true,
    loggedIn: false,
    elsewhere: false,
    session: undefined,
    expected: { kind: 'unreachable', face: ALERT, busy: true },
  },
  {
    case: 'sign-out waits while signed in',
    knowledge: 'known',
    signingOut: true,
    loggedIn: true,
    elsewhere: false,
    session: ALICE,
    expected: { kind: 'signingOut', face: { kind: 'account', session: ALICE } },
  },
  {
    case: 'sign-out waits after another tab signed out and a sign-in waits elsewhere',
    knowledge: 'known',
    signingOut: true,
    loggedIn: false,
    elsewhere: true,
    session: ALICE,
    expected: { kind: 'signingOut', face: RESUMING },
  },
  {
    case: 'sign-out waits after another tab signed out',
    knowledge: 'known',
    signingOut: true,
    loggedIn: false,
    elsewhere: false,
    session: ALICE,
    expected: { kind: 'signingOut', face: PROMPT },
  },
  {
    case: 'sign-in made elsewhere waits',
    knowledge: 'known',
    signingOut: false,
    loggedIn: false,
    elsewhere: true,
    session: undefined,
    expected: { kind: 'resume', face: RESUMING },
  },
  {
    case: 'session is known and signed out',
    knowledge: 'known',
    signingOut: false,
    loggedIn: false,
    elsewhere: false,
    session: ALICE,
    expected: { kind: 'signIn', face: PROMPT },
  },
  {
    case: 'session is logged in with no account to show',
    knowledge: 'known',
    signingOut: false,
    loggedIn: true,
    elsewhere: false,
    session: undefined,
    expected: { kind: 'signedIn', face: { kind: 'account', session: undefined } },
  },
  {
    case: 'session is known and signed in',
    knowledge: 'known',
    signingOut: false,
    loggedIn: true,
    elsewhere: false,
    session: ALICE,
    expected: { kind: 'signedIn', face: { kind: 'account', session: ALICE } },
  },
  {
    case: 'session is signed in while a sign-in waits elsewhere',
    knowledge: 'known',
    signingOut: false,
    loggedIn: true,
    elsewhere: true,
    session: ALICE,
    expected: { kind: 'signedIn', face: { kind: 'account', session: ALICE } },
  },
];

describe('getAuthButtonState', () => {
  it.each(ROWS)(
    'As a visitor whose $case, I see the auth button as $expected.kind',
    ({ knowledge, signingOut, loggedIn, elsewhere, session, expected }) => {
      // Given an account in the row's state
      const account = {
        knowledge: () => knowledge,
        signingOut: () => signingOut,
        loggedIn: () => loggedIn,
        elsewhere: () => elsewhere,
        session: () => session,
      };

      // When the button decides what it shows
      const state = getAuthButtonState(account);

      // Then it shows the row's state and face
      expect(state).toEqual(expected);
    },
  );
});
