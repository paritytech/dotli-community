// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// This site's local wallet, which the protocol frame keeps in the shared store under this site's id.

import { SITE_ID } from '@dotli/config';
import { protocolClient, type LocalWalletIdentity, type LocalWalletReadResult } from '@dotli/protocol';

/** A wallet read, or why the frame could not answer it. */
export type WalletRead = LocalWalletReadResult | { status: 'failed'; error: unknown };

export type SiteWallet = {
  /** Reads the stored wallet, or answers that there is none. */
  read(): Promise<LocalWalletReadResult>;
  /** Stores the wallet's entropy, with the identity derived from it, where a `null` identity stores none yet. */
  save(entropy: Uint8Array, identity: LocalWalletIdentity | null): Promise<void>;
  /** Replaces the identity stored with the wallet and leaves its entropy as it is. */
  updateIdentity(identity: LocalWalletIdentity): Promise<void>;
  /** Forgets the wallet whatever version the store holds. */
  forget(): Promise<void>;
  /** Forgets the wallet only while the store still holds `version`. Resolves whether it went. */
  forgetIf(version: Uint8Array): Promise<boolean>;
};

/** This site's local wallet in the shared store. Each call reaches the protocol frame when made. */
export const siteWallet: SiteWallet = {
  read: () => protocolClient().readSharedLocalWallet(SITE_ID),
  save: (entropy, identity) => protocolClient().saveSharedLocalWallet(SITE_ID, entropy, identity),
  updateIdentity: identity => protocolClient().updateSharedLocalWalletIdentity(SITE_ID, identity),
  forget: () => protocolClient().forgetSharedLocalWallet(SITE_ID),
  forgetIf: version => protocolClient().forgetSharedLocalWalletIf(SITE_ID, version),
};

/** The wallet read, or the failure of a read that rejected or threw. Never rejects. */
export async function readWalletOrFailed(read: () => Promise<LocalWalletReadResult>): Promise<WalletRead> {
  try {
    return await read();
  } catch (error) {
    return { status: 'failed', error };
  }
}
