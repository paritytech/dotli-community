// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSyncStore, shallowEqual, type ReadableStore } from '@dotli/shared';
import type { PairingView } from './auth-modal.js';

/**
 * What the sign-in window shows. `connecting` waits for a vetted hello, `refused` turned its opener away, and
 * `done-no-opener` ends a sign-in no page opened. `continue`, `pairing` and `phrase` sign in, `failed` says a step whose
 * view cannot go on failed and offers Retry, `signing-out` signs out, and `signed-out` ends a sign-out that told the
 * phone, which the user closes.
 */
export type WindowView =
  | 'connecting'
  | 'continue'
  | 'pairing'
  | 'phrase'
  | 'failed'
  | 'refused'
  | 'signing-out'
  | 'signed-out'
  | 'done-no-opener';

/** The names a stored sign-in shows. */
export interface OfferedAccount {
  publicKey?: string;
  identityAccountId?: string;
  liteUsername?: string;
  fullUsername?: string;
  primaryUsername?: string;
}

/** What Continue offers: the local wallet when one is stored, since a page boots on it, else the paired session. */
export interface ContinueOffer {
  wallet: 'local' | 'paired';
  /** Null when the store has no names, which a wallet imported in the window leaves. */
  account: OfferedAccount | null;
}

/**
 * A step the user asked for that failed, shown on the view it left. `sign-out` is Use another account's, and `phone`
 * is its sign-out that the phone could not be told of, which the user may try again or go on from.
 */
export type WindowFailure = 'sign-out' | 'phone' | 'step';

/** What every view of a sign-in carries, whichever view is on show. */
interface SignInFields {
  /** The page the window signs in for, named above the QR code. */
  pageHost: string | null;
  failure: WindowFailure | null;
  /** How far the pairing under way got, as the window's core reports it. A view other than the pairing's keeps it. */
  pairing: PairingView;
}

/** A view of a sign-in. Only Continue offers an account, and it always has one to offer. */
export type SignInScreen =
  | (SignInFields & { view: 'continue'; offer: ContinueOffer })
  | (SignInFields & { view: Exclude<WindowView, 'continue' | 'signing-out' | 'signed-out'> });

/** What the window shows. A sign-out only says where it stands, so it carries nothing of a sign-in. */
export type WindowScreen = SignInScreen | { view: 'signing-out' } | { view: 'signed-out' };

// The page renders its first paint from this, so it starts where every window starts.
const sessionWindow = createSyncStore<WindowScreen>(
  'sessionWindow',
  { view: 'connecting', pageHost: null, failure: null, pairing: { kind: 'spinner' } },
  { equals: shallowEqual },
);

export const sessionWindowStore: ReadableStore<WindowScreen> = sessionWindow;

/** Shows what `source` shows until the returned stop, so the island can mount before its source store exists. */
export function showWindowScreen(source: ReadableStore<WindowScreen>): () => void {
  sessionWindow.set(source.get());
  return source.subscribe(() => {
    sessionWindow.set(source.get());
  });
}

/** Shows one screen, for a window that has no flow behind it. */
export function setWindowScreen(next: WindowScreen): void {
  sessionWindow.set(next);
}

/** What the window's controls ask of its flow. Only the phrase import rejects, and every failure is reported. */
export interface WindowIntents {
  continueWithStored(): Promise<void>;
  useAnotherAccount(): Promise<void>;
  /** After Use another account could not tell the phone, goes on to sign in another account anyway. */
  goOnWithoutPhone(): Promise<void>;
  /** Whether `phrase` is a recovery phrase, false until the check loaded, which it has once the phrase view shows. */
  isValidPhrase(phrase: string): boolean;
  /** Rejects when the phrase could not be imported, which is already reported, so the form only says so. */
  importPhrase(phrase: string): Promise<void>;
  /** Back to what the store offers, or to the pairing. */
  closePhrase(): Promise<void>;
  /** From the failed view, decides again what to show from the main store, and after a failed pairing pairs again. */
  retry(): Promise<void>;
  /** Ends a round the user gave up on and closes the window. */
  cancel(): void;
}

// The window's flow, for the island, which hydrates on its own and so cannot be handed it.
let pageIntents: WindowIntents | null = null;

export function setWindowIntents(intents: WindowIntents): void {
  pageIntents = intents;
}

/**
 * The running flow's intents. Only the views the flow shows offer a control that asks it, so the flow exists by the
 * time one is pressed.
 */
export function windowIntents(): WindowIntents {
  if (pageIntents === null) {
    throw new Error('Session window flow used before it started');
  }
  return pageIntents;
}
