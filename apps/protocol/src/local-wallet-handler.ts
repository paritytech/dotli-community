// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves the local wallet to host pages. Same trust boundary as shared auth storage: host and landing origins of this
// root domain only, never product origins.

import {
  isSharedAuthOriginAllowed,
  isSharedAuthSiteId,
  isSharedWalletRequestMethod,
  type LocalWalletIdentity,
  type LocalWalletReadResult,
  type ProtocolRequestEnvelope,
  type ProtocolRequestMap,
} from '@dotli/protocol';
import {
  forgetLocalWallet,
  loadLocalWallet,
  LocalWalletUnreadableError,
  saveLocalWallet,
  updateLocalWalletIdentity,
} from '@dotli/storage';

const ENTROPY_LENGTHS = new Set([16, 20, 24, 28, 32]);

function assertEntropy(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || !ENTROPY_LENGTHS.has(value.length)) {
    throw new Error('Invalid local wallet entropy');
  }
}

function assertIdentity(value: unknown): asserts value is LocalWalletIdentity {
  const identity = value as Partial<LocalWalletIdentity> | null;
  if (
    typeof identity !== 'object' ||
    identity === null ||
    typeof identity.identityAccountId !== 'string' ||
    !(identity.liteUsername === null || typeof identity.liteUsername === 'string')
  ) {
    throw new Error('Invalid local wallet identity');
  }
}

/** An undecryptable record can never be used again, so it is deleted and reported to the caller. */
async function read(): Promise<LocalWalletReadResult> {
  try {
    const wallet = await loadLocalWallet();
    return wallet === null ? { status: 'none' } : { status: 'ok', entropy: wallet.entropy, identity: wallet.identity };
  } catch (error) {
    if (!(error instanceof LocalWalletUnreadableError)) {
      throw error;
    }
    await forgetLocalWallet();
    return { status: 'unreadable' };
  }
}

export async function handleLocalWalletRequest(request: ProtocolRequestEnvelope, origin: string): Promise<unknown> {
  if (!isSharedAuthOriginAllowed(origin)) {
    throw new Error(`Local wallet request denied from origin: ${origin}`);
  }
  if (!isSharedWalletRequestMethod(request.method)) {
    throw new Error(`Not a local wallet request: ${request.method}`);
  }
  const { siteId } = request.payload as { siteId?: unknown };
  if (typeof siteId !== 'string' || !isSharedAuthSiteId(siteId)) {
    throw new Error(`Invalid siteId: ${String(siteId)}`);
  }

  switch (request.method) {
    case 'localWalletRead':
      return read();
    case 'localWalletSave': {
      const { entropy } = request.payload as ProtocolRequestMap['localWalletSave'];
      assertEntropy(entropy);
      await saveLocalWallet(entropy);
      return true;
    }
    case 'localWalletIdentity': {
      const { identity } = request.payload as ProtocolRequestMap['localWalletIdentity'];
      assertIdentity(identity);
      await updateLocalWalletIdentity(identity);
      return true;
    }
    case 'localWalletForget':
      await forgetLocalWallet();
      return true;
  }
}
