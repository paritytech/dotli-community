// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sign-in modal's machine types and the seam between the auth controller, which runs that machine, and the one
// route a page signs in by. A route moves the modal only through the controller's modal steps it is given.

import type { HandlerOf, MachineTypes, StateHandlers, Transition } from '@dotli/shared';
import type { LoginFailureKind } from '@parity/truapi-host';
import type { AuthModalView } from '../state/authModalState.js';
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
 * that the check could not load, so Retry asks for a phrase again.
 */
export type SignInRound =
  | { kind: 'idle' }
  | { kind: 'windowOpen'; intent: SignInIntent }
  | { kind: 'resultWriting'; intent: SignInIntent }
  | { kind: 'windowClosed'; intent: SignInIntent }
  | { kind: 'phraseLoading' }
  | { kind: 'phraseShown'; phrase: InPagePhrase }
  | { kind: 'phraseFailed' };

/**
 * The sign-in modal's hold on the blocking-modal queue, with the round it shows. `disabled` keeps its round, so a
 * window already open still signs in.
 */
export type AuthModalLease =
  | { kind: 'closed'; round: SignInRound }
  | { kind: 'queued'; round: SignInRound; scope: BlockingModalScope }
  | { kind: 'open'; round: SignInRound; scope: BlockingModalScope; release: () => void }
  | { kind: 'disabled'; round: SignInRound }
  | { kind: 'disposed' };

export type LiveLease = Exclude<AuthModalLease, { kind: 'disposed' }>;

/** The round events carry the round they are for, so a late one finds a round that moved on and changes nothing. */
export type AuthModalEvent =
  | { kind: 'opened'; params: OpenAuthModalParams }
  | { kind: 'loginAsked'; params: StartLoginParams }
  | { kind: 'loginCommanded'; reason: StartLoginParams['reason'] }
  | { kind: 'phraseAsked' }
  | { kind: 'closeAsked'; params: CloseAuthModalParams }
  | { kind: 'disableAsked' }
  | { kind: 'disposeAsked' }
  | { kind: 'logoutAsked' }
  | { kind: 'focusAsked' }
  | { kind: 'authStepped'; state: DotliAuthState; wasSignedIn: boolean }
  | { kind: 'leaseGranted'; scope: BlockingModalScope; signal: AbortSignal; release: () => void }
  | { kind: 'failureShown'; failure: LoginFailureKind; reason: string }
  | { kind: 'commandEnded' }
  | { kind: 'windowEnded'; round: SignInRound; outcome: SignInOutcome }
  | { kind: 'resultWritten'; round: SignInRound; written: 'applied' | 'reloading' }
  | { kind: 'resultFailed'; round: SignInRound; reason: string }
  | { kind: 'phraseLoaded'; round: SignInRound; phrase: InPagePhrase }
  | { kind: 'phraseMissed'; round: SignInRound; reason: string };

/**
 * What the controller does once a transition moved the modal. `authLogged` keeps the auth state's tag and failure kind
 * only, since a failure's reason can carry wallet text.
 */
export type AuthModalEffect =
  | { kind: 'authLogged'; tag: DotliAuthState['tag']; failure: LoginFailureKind | null }
  | { kind: 'roundEnded'; reason: PageCancelReason }
  | { kind: 'leaseReleased'; held: LiveLease }
  | { kind: 'leaseRefused'; release: () => void }
  | { kind: 'modalShown' }
  | { kind: 'stepsUnfollowed' }
  | { kind: 'signOutOpened' }
  | { kind: 'windowFocused' };

export type AuthModalMachine = MachineTypes<AuthModalLease, AuthModalEvent, AuthModalEffect>;

export type SignInRoundMachine = MachineTypes<SignInRound, AuthModalEvent, AuthModalEffect>;

/** What a sign-in may do with the page's sign-in modal before the route takes over. */
export type AuthModalPort = {
  /** Returns the modal's current lease, compared by identity, or null while none is held. Never throws. */
  getLease(): object | null;
  /** Shows `view` in the modal. Never throws. */
  show(view: AuthModalView): void;
};

/** One way a page signs in, as handlers of the modal's machine. Two routes implement it. */
export type SignInRoute = {
  /** Called only while signed out and while the saved session is reachable. Never throws. */
  startLogin: HandlerOf<AuthModalMachine, LiveLease['kind'], 'loginAsked'>;
  /** Called only while the saved session is reachable. Never throws. */
  importPhrase: HandlerOf<AuthModalMachine, LiveLease['kind'], 'phraseAsked'>;
  /** The core paired, or a product asked to log in. Never throws. */
  pairing(state: LiveLease, pairing: PairingState, transition: Transition<AuthModalMachine>): void;
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
export function isLeaseHeld(lease: AuthModalLease): boolean {
  switch (lease.kind) {
    case 'queued':
    case 'open':
      return true;
    case 'closed':
    case 'disabled':
    case 'disposed':
      return false;
  }
}

/** Whether the modal is disabled, so a login the page asks for is cancelled rather than shown. */
export function isLeaseDisabled(lease: LiveLease): boolean {
  switch (lease.kind) {
    case 'disabled':
      return true;
    case 'closed':
    case 'queued':
    case 'open':
      return false;
  }
}

/** The blocking-modal scope `lease` holds, or null when it holds none. */
export function getLeaseScope(lease: AuthModalLease): BlockingModalScope | null {
  switch (lease.kind) {
    case 'queued':
    case 'open':
      return lease.scope;
    case 'closed':
    case 'disabled':
    case 'disposed':
      return null;
  }
}

/** The round `lease` holds, or null once the modal is disposed. */
export function getRound(lease: AuthModalLease): SignInRound | null {
  switch (lease.kind) {
    case 'closed':
    case 'queued':
    case 'open':
    case 'disabled':
      return lease.round;
    case 'disposed':
      return null;
  }
}

/** Gives up the place `lease` holds in the blocking-modal queue: ends its screen time and disposes its scope. */
export function releaseLeaseHold(lease: LiveLease): void {
  if (lease.kind === 'open') {
    lease.release();
  }
  getLeaseScope(lease)?.dispose('Authentication modal closed');
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
    case 'windowOpen':
    case 'resultWriting':
    case 'windowClosed':
    case 'phraseLoading':
    case 'phraseFailed':
      return null;
  }
}
