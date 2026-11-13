// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// What the sign-in window reads of the main store, as a result carries it. A store that cannot be read may still hold
// a session, so a failed session read rejects. A wallet that cannot be read is reported and taken as none, so the
// window still offers a session or pairs.

import type { LocalWalletReadResult } from '@dotli/protocol';
import type { HostCoreStorage } from '../session/createCoreStorage.js';
import { reportLocalWalletFailure } from '../walletFailure.js';
import type { SessionResult } from './parseSessionResult.js';

type Params = {
  store: Pick<HostCoreStorage, 'readSession' | 'readUiCache'>;
  wallet: {
    /** Reads the main store's local wallet. Rejects when it could not be read. */
    read: () => Promise<LocalWalletReadResult>;
  };
};

/** The sign-in window's reads of the main store. */
export function createMainStoreReads({ store, wallet }: Params) {
  return {
    /** What the store holds. Rejects when its session could not be read. */
    readStored,
    /**
     * What the store holds now, for Continue over `offered`. A sign-out on another page clears the session and the
     * wallet, so those are read again. The cached account goes with the session it was read for. Rejects when the
     * session could not be read.
     */
    readStoredForContinue,
    /** The session a login just paired, with the wallet. Rejects when it could not be read or is no longer stored. */
    readPaired,
    /** The session with its cached account. Rejects when the session could not be read. */
    readSession,
    /** Whether the store holds no session, false when it could not be read. */
    isSessionGone,
  };

  async function readBlob(): Promise<string | null> {
    const read = await store.readSession();
    if (read.status === 'failed') {
      throw new Error('The main store could not be read', { cause: read.error });
    }
    return read.blob;
  }

  async function readWallet(): Promise<SessionResult['localWallet']> {
    try {
      const read = await wallet.read();
      return read.status === 'ok' ? { entropy: read.entropy, identity: read.identity } : null;
    } catch (error) {
      reportLocalWalletFailure(error, 'read');
      return null;
    }
  }

  async function readSession(): Promise<SessionResult['session']> {
    // The cache read never rejects, so only a failed blob read fails it.
    const [blob, uiState] = await Promise.all([readBlob(), store.readUiCache()]);
    return blob === null ? null : { blob, uiState };
  }

  async function readStored(): Promise<SessionResult> {
    const [session, localWallet] = await Promise.all([readSession(), readWallet()]);
    return { session, localWallet };
  }

  async function readStoredForContinue(offered: SessionResult): Promise<SessionResult> {
    const [blob, localWallet] = await Promise.all([readBlob(), readWallet()]);
    if (blob === null) {
      return { session: null, localWallet };
    }
    const uiState = blob === offered.session?.blob ? offered.session.uiState : await store.readUiCache();
    return { session: { blob, uiState }, localWallet };
  }

  async function readPaired(): Promise<{ blob: string; localWallet: SessionResult['localWallet'] }> {
    const [blob, localWallet] = await Promise.all([readBlob(), readWallet()]);
    if (blob === null) {
      throw new Error('The paired session is no longer stored');
    }
    return { blob, localWallet };
  }

  async function isSessionGone(): Promise<boolean> {
    const read = await store.readSession();
    return read.status === 'ok' && read.blob === null;
  }
}
