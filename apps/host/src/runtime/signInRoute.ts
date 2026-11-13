// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in modal's machine types and the seam between the auth controller, which runs that machine, and the one
// route a page signs in by. A route moves the modal only through the controller's modal steps it is given.

import type { HandlerOf, MachineTypes, StateHandlers, Transition } from '@dotli/shared';
import type { LoginFailureKind } from '@parity/truapi-host';
import type { AuthModalView } from '../state/authModalState.js';
import type { LoginParams } from './createAuthCommands.js';
import type { BlockingModalScope } from './createBlockingModalCoordinator.js';
import type { WalletSwitchOutcome } from './createWalletSwitch.js';
import type { DotliAuthState, PairingState } from './session/types.js';
import type { PageCancelReason, SignInOutcome } from './sessionHandoff/createSessionHandoff.js';
import type { SignInIntent } from './sessionHandoff/parseWindowRequest.js';

/** Why a sign-in starts and which product it is for. */
export type StartLoginParams = {
  /** Why the sign-in was asked for, which the modal shows. */
  reason?: string | undefined;
  /** The product the sign-in is for, which the modal names. */
  label?: string | undefined;
};

/** What the modal shows when it opens. */
export type OpenAuthModalParams = StartLoginParams & {
  /** False shows the label as it is, with no active TLD added. */
  dotSuffix?: boolean | undefined;
};

/** How the modal closes. */
export type CloseAuthModalParams = {
  /** Leaves the core's login running, for a page that signed in meanwhile. */
  skipTruapiCancel?: boolean;
  /** Why an open window round ends with the modal, `page` by default. */
  cancel?: PageCancelReason;
};

/** The recovery phrase import of a page that pairs in place. */
export type InPagePhrase = {
  /** The phrase's entropy, or null for anything that is not a recovery phrase. */
  toEntropy(phrase: string): Uint8Array | null;
  /** Uses the wallet in every app on the domain and reloads. A failure is reported there and answered as `failed`. */
  useLocalWallet(entropy: Uint8Array): Promise<WalletSwitchOutcome>;
};

/**
 * The round the route shows in the modal. `windowOpen` waits for the sign-in window, and `resultWriting` writes its
 * result while the wait stays on show. `windowClosed` shows why the window could not sign in, and its Retry opens the
 * window again with the round's intent. `phraseShown` is the phrase view with its loaded check, and `phraseFailed` shows
 * that the check could not load, so Retry asks for a phrase again. `rereading` reads the saved session again for a
 * sign-in asked while it could not be reached, before the sign-in goes on, and `rereadMissed` shows that the read still
 * could not reach it, so Retry asks for the same again.
 */
export type SignInRound =
  | { kind: 'idle' }
  | { kind: 'rereading'; asked: 'login' | 'phrase'; reason: StartLoginParams['reason'] }
  | { kind: 'rereadMissed'; asked: 'login' | 'phrase' }
  | { kind: 'windowOpen'; intent: SignInIntent }
  | { kind: 'resultWriting'; intent: SignInIntent }
  | { kind: 'windowClosed'; intent: SignInIntent }
  | { kind: 'phraseLoading' }
  | { kind: 'phraseShown'; phrase: InPagePhrase }
  | { kind: 'phraseFailed' };

/** The sign-in modal's hold on the blocking-modal queue. */
export type ModalLease =
  | { kind: 'closed' }
  | { kind: 'queued'; scope: BlockingModalScope }
  | { kind: 'open'; scope: BlockingModalScope; release: () => void }
  | { kind: 'disabled' };

/**
 * The sign-in modal: its lease, the round the route shows, the auth step the page showed last, and the view on show. A
 * disabled lease keeps its round, so a window already open still signs in.
 */
export type AuthModalState =
  | { kind: 'live'; lease: ModalLease; round: SignInRound; auth: DotliAuthState; view: AuthModalView }
  | { kind: 'disposed' };

export type LiveModal = Extract<AuthModalState, { kind: 'live' }>;

/** The round events carry the round they are for, so a late one finds a round that moved on and changes nothing. */
export type AuthModalEvent =
  | { kind: 'opened'; params: OpenAuthModalParams }
  | { kind: 'loginAsked'; params: StartLoginParams }
  | { kind: 'phraseAsked' }
  | { kind: 'retryAsked' }
  | { kind: 'closeAsked'; params: CloseAuthModalParams }
  | { kind: 'disableAsked' }
  | { kind: 'disposeAsked' }
  | { kind: 'logoutAsked' }
  | { kind: 'focusAsked' }
  | { kind: 'authStepped'; state: DotliAuthState }
  | { kind: 'leaseGranted'; scope: BlockingModalScope; signal: AbortSignal; release: () => void }
  | { kind: 'failureShown'; failure: LoginFailureKind; reason: string }
  // No state handles it, so a command's work ends with an event `await()` covers.
  | { kind: 'commandEnded' }
  | { kind: 'windowEnded'; round: SignInRound; outcome: SignInOutcome }
  | { kind: 'resultWritten'; round: SignInRound; written: 'applied' | 'reloading' }
  | { kind: 'resultFailed'; round: SignInRound; reason: string }
  | { kind: 'phraseLoaded'; round: SignInRound; phrase: InPagePhrase }
  | { kind: 'phraseMissed'; round: SignInRound; reason: string }
  // A round asks the modal to show a view, as a nested value never moves the state around it.
  | { kind: 'viewAsked'; view: AuthModalView }
  | { kind: 'rereadEnded'; round: SignInRound }
  | { kind: 'rereadFailed'; round: SignInRound; error: unknown };

/** A sign-in command the controller runs on the core once the bridge chunk loads. */
export type AuthCommand = { step: 'login'; params: LoginParams } | { step: 'logout' } | { step: 'cancel_login' };

/**
 * What the controller does once a transition moved the modal. `authLogged` keeps the auth state's tag and failure kind
 * only, since a failure's reason can carry wallet text. `modalReset` puts a fresh modal on its spinner.
 */
export type AuthModalEffect =
  | { kind: 'authLogged'; tag: DotliAuthState['tag']; failure: LoginFailureKind | null }
  | { kind: 'modalReset'; productLabel: string | null; reason: string | null }
  | { kind: 'viewShown'; view: AuthModalView }
  | { kind: 'modalShown' }
  | { kind: 'leaseQueued'; scope: BlockingModalScope }
  | { kind: 'leaseReleased'; lease: ModalLease }
  | { kind: 'leaseRefused'; release: () => void }
  | { kind: 'rereadLogged'; error: unknown }
  | { kind: 'roundEnded'; reason: PageCancelReason }
  | { kind: 'stepsUnfollowed' }
  | { kind: 'signOutOpened' }
  | { kind: 'windowFocused' };

export type AuthModalMachine = MachineTypes<AuthModalState, AuthModalEvent, AuthModalEffect>;

export type SignInRoundMachine = MachineTypes<SignInRound, AuthModalEvent, AuthModalEffect>;

/** One way a page signs in, as handlers of the modal's machine. Two routes implement it. */
export type SignInRoute = {
  /** Called only while signed out and while the saved session is reachable. Never throws. */
  startLogin: HandlerOf<AuthModalMachine, 'live', 'loginAsked'>;
  /** Called only while the saved session is reachable. Never throws. */
  importPhrase: HandlerOf<AuthModalMachine, 'live', 'phraseAsked'>;
  /** The core paired, or a product asked to log in. Never throws. */
  pairing(state: LiveModal, pairing: PairingState, transition: Transition<AuthModalMachine>): void;
  /** Opens the sign-out window first, where the route has one. Never throws. */
  signOut(): void;
  /** Brings the route's sign-in window to the front, where it has one. Never throws. */
  focus(): void;
  /** The modal closed, so the route's round ends. Never throws. */
  end(reason: PageCancelReason): void;
  /** The route's rounds, each of the other route's kinds `null`. */
  rounds: StateHandlers<SignInRoundMachine>;
};

/** Whether `lease` holds a place in the blocking-modal queue, waiting for the screen or on it. */
export function isLeaseHeld(lease: ModalLease): boolean {
  switch (lease.kind) {
    case 'queued':
    case 'open':
      return true;
    case 'closed':
    case 'disabled':
      return false;
  }
}

/** Whether the modal is disabled, so a login the page asks for is cancelled rather than shown. */
export function isLeaseDisabled(lease: ModalLease): boolean {
  switch (lease.kind) {
    case 'disabled':
      return true;
    case 'closed':
    case 'queued':
    case 'open':
      return false;
  }
}

/** The round the modal holds, or null once it is disposed. */
export function getRound(state: AuthModalState): SignInRound | null {
  switch (state.kind) {
    case 'live':
      return state.round;
    case 'disposed':
      return null;
  }
}

/** Gives up the place `lease` holds in the blocking-modal queue: ends its screen time and disposes its scope. */
export function releaseLeaseHold(lease: ModalLease): void {
  switch (lease.kind) {
    case 'open':
      lease.release();
      lease.scope.dispose('Authentication modal closed');
      return;
    case 'queued':
      lease.scope.dispose('Authentication modal closed');
      return;
    case 'closed':
    case 'disabled':
      return;
  }
}

/**
 * Whether the route's own wait is on show. That wait is the sign-in itself, so the core's login states must not cover
 * or end it. The route's own outcome ends it.
 */
export function isWaiting(round: SignInRound): boolean {
  switch (round.kind) {
    case 'windowOpen':
    case 'resultWriting':
      return true;
    case 'idle':
    case 'rereading':
    case 'rereadMissed':
    case 'windowClosed':
    case 'phraseLoading':
    case 'phraseShown':
    case 'phraseFailed':
      return false;
  }
}

/** Whether Retry imports a phrase rather than logs in after `round`. */
export function isPhraseRound(round: SignInRound): boolean {
  switch (round.kind) {
    case 'windowOpen':
    case 'resultWriting':
    case 'windowClosed':
      return round.intent === 'phrase';
    case 'rereading':
    case 'rereadMissed':
      return round.asked === 'phrase';
    case 'phraseFailed':
      return true;
    case 'idle':
    case 'phraseLoading':
    case 'phraseShown':
      return false;
  }
}

/** The phrase check the phrase view on show uses, or null while `round` shows none. */
export function getShownPhrase(round: SignInRound): InPagePhrase | null {
  switch (round.kind) {
    case 'phraseShown':
      return round.phrase;
    case 'idle':
    case 'rereading':
    case 'rereadMissed':
    case 'windowOpen':
    case 'resultWriting':
    case 'windowClosed':
    case 'phraseLoading':
    case 'phraseFailed':
      return null;
  }
}
