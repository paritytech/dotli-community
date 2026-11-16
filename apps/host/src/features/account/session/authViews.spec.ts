// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { authViews, type LoginStep, type SessionKnowledge } from './authViews.js';
import type { TruapiSessionUiState } from './parseUiStateCache.js';
import type { DotliAuthState, PairingState } from './types.js';

const ALICE: TruapiSessionUiState = { connected: true, fullUsername: 'Alice Smith' };
const PAIRING: PairingState = { tag: 'Pairing', deeplink: 'polkadotapp://pair?handshake=test', label: 'app' };
const FAILED: DotliAuthState = { tag: 'LoginFailed', kind: 'Other', reason: 'Rejected on the phone' };

type Row = {
  state: DotliAuthState;
  knowledge: SessionKnowledge;
  awaiting: boolean;
  unreachable: boolean;
  session: TruapiSessionUiState | null;
  step: LoginStep | null;
  idle: boolean;
  running: boolean;
  loggedIn: boolean | null;
};

const ROWS: Row[] = [
  {
    state: { tag: 'Restoring' },
    knowledge: 'reading',
    awaiting: true,
    unreachable: false,
    session: null,
    step: null,
    idle: false,
    running: false,
    loggedIn: null,
  },
  {
    state: { tag: 'Unreachable' },
    knowledge: 'unreachable',
    awaiting: true,
    unreachable: true,
    session: null,
    step: null,
    idle: false,
    running: false,
    loggedIn: false,
  },
  {
    state: { tag: 'Disconnected' },
    knowledge: 'known',
    awaiting: false,
    unreachable: false,
    session: null,
    step: null,
    idle: true,
    running: false,
    loggedIn: false,
  },
  {
    state: PAIRING,
    knowledge: 'known',
    awaiting: false,
    unreachable: false,
    session: null,
    step: { step: 'pairing', pairing: PAIRING },
    idle: false,
    running: true,
    loggedIn: null,
  },
  {
    state: { tag: 'Authenticating' },
    knowledge: 'known',
    awaiting: false,
    unreachable: false,
    session: null,
    step: { step: 'authenticating' },
    idle: false,
    running: true,
    loggedIn: null,
  },
  {
    state: { tag: 'Connected', session: ALICE },
    knowledge: 'known',
    awaiting: false,
    unreachable: false,
    session: ALICE,
    step: null,
    idle: false,
    running: false,
    loggedIn: true,
  },
  {
    state: FAILED,
    knowledge: 'known',
    awaiting: false,
    unreachable: false,
    session: null,
    step: { step: 'failed', kind: 'Other', reason: 'Rejected on the phone' },
    idle: true,
    running: false,
    loggedIn: null,
  },
];

describe('authViews', () => {
  it.each(ROWS)(
    'As the host, I ask what the page knows of the saved session while it shows $state.tag and get $knowledge',
    ({ state, knowledge }) => {
      // Given the auth state on show

      // When the host asks what the page knows of the saved session
      const answer = authViews.getSessionKnowledge(state);

      // Then it gets the knowledge that state stands for
      expect(answer).toBe(knowledge);
    },
  );

  it.each(ROWS)(
    'As the host, I ask whether the saved session is still awaited while it shows $state.tag and get $awaiting',
    ({ state, awaiting }) => {
      // Given the auth state on show

      // When the host asks whether the saved session is still awaited
      const answer = authViews.isAwaitingSavedSession(state);

      // Then only a state a read of the saved session may end answers yes
      expect(answer).toBe(awaiting);
    },
  );

  it.each(ROWS)(
    'As the host, I ask whether the saved session is unreachable while it shows $state.tag and get $unreachable',
    ({ state, unreachable }) => {
      // Given the auth state on show

      // When the host asks whether the saved session is unreachable
      const answer = authViews.isSessionUnreachable(state);

      // Then only a failed read of the saved session answers yes
      expect(answer).toBe(unreachable);
    },
  );

  it.each(ROWS)(
    'As the host, I ask for the signed-in session while it shows $state.tag and get the session it carries',
    ({ state, session }) => {
      // Given the auth state on show

      // When the host asks for the signed-in session
      const answer = authViews.getSignedInSession(state);

      // Then it gets the session the state carries itself, or null
      expect(answer).toBe(session);
    },
  );

  it.each(ROWS)(
    'As the host, I ask for the login step on show while it shows $state.tag and get the step it stands for',
    ({ state, step }) => {
      // Given the auth state on show

      // When the host asks for the login step on show
      const answer = authViews.getLoginStep(state);

      // Then it gets the step that state stands for, or null
      expect(answer).toEqual(step);
    },
  );

  it.each(ROWS)(
    'As the host, I ask whether a sign-in may start while it shows $state.tag and get $idle',
    ({ state, idle }) => {
      // Given the auth state on show

      // When the host asks whether a sign-in may start
      const answer = authViews.isSignInIdle(state);

      // Then only a known session with nothing on show answers yes
      expect(answer).toBe(idle);
    },
  );

  it.each(ROWS)(
    'As the host, I ask whether a core login is running while it shows $state.tag and get $running',
    ({ state, running }) => {
      // Given the auth state on show

      // When the host asks whether a core login is running
      const answer = authViews.isLoginRunning(state);

      // Then only pairing and authenticating answer yes
      expect(answer).toBe(running);
    },
  );

  it.each(ROWS)(
    'As the host, I ask what the step says of being logged in while it shows $state.tag and get $loggedIn',
    ({ state, loggedIn }) => {
      // Given the auth state on show

      // When the host asks what the step says of being logged in
      const answer = authViews.getLoggedInChange(state);

      // Then it gets the change that state makes, or null to leave it as it was
      expect(answer).toBe(loggedIn);
    },
  );
});
