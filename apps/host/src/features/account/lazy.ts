// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points, each its own chunk, so the page boot leaves them out.

import type * as AccountContentNamespace from './panel/AccountContent.js';
import type * as LocalWalletCoreNamespace from './session/localWalletCore.js';
import type * as PhraseScreenNamespace from './signIn/PhraseScreen.js';
import type * as RecoveryPhraseNamespace from './signIn/recoveryPhrase.js';

export type LocalWalletCoreModule = typeof LocalWalletCoreNamespace;

export type PhraseScreenModule = typeof PhraseScreenNamespace;

/** The account view. Rejects when its chunk fails to load. */
export function loadAccountContent(): Promise<typeof AccountContentNamespace> {
  return import('./panel/AccountContent.js');
}

/** The signing worker's constructor. Rejects when its chunk fails to load. */
export function loadSigningWorker(): Promise<{ default: new () => Worker }> {
  return import('./session/signingWorker.js?worker');
}

/** The recovery phrase check, which only a phrase import needs. Rejects when its chunk fails to load. */
export function loadRecoveryPhrase(): Promise<typeof RecoveryPhraseNamespace> {
  return import('./signIn/recoveryPhrase.js');
}

/** The debug-only recovery phrase form, which only a phrase view shows. Rejects when its chunk fails to load. */
export function loadPhraseScreen(): Promise<PhraseScreenModule> {
  return import('./signIn/PhraseScreen.js');
}

/** The in-page wallet core. Rejects when its chunk fails to load. */
export function loadLocalWalletCore(): Promise<LocalWalletCoreModule> {
  return import('./session/localWalletCore.js');
}
