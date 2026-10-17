// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves the local wallet to host pages. Same trust boundary as shared auth storage: host and landing origins of this
// root domain only, never product origins.

import {
  isSharedAuthOriginAllowed,
  isSharedAuthSiteId,
  type Answer,
  type CallContext,
  type RequestHandler,
  type ServingTransport,
} from '@dotli/protocol';
import {
  forgetLocalWallet,
  loadLocalWallet,
  LocalWalletUnreadableError,
  saveLocalWallet,
  updateLocalWalletIdentity,
  type LocalWalletStore,
} from '@dotli/storage';

import { OriginDeniedError } from './errors.js';

const pageWallet: LocalWalletStore = { forgetLocalWallet, loadLocalWallet, saveLocalWallet, updateLocalWalletIdentity };

const ENTROPY_LENGTHS = new Set([16, 20, 24, 28, 32]);

function assertEntropy(value: Uint8Array): void {
  if (!ENTROPY_LENGTHS.has(value.length)) {
    throw new Error('Invalid local wallet entropy');
  }
}

/** Checks a call's origin and site before it touches the wallet. */
function admit(payload: { siteId: string }, context: CallContext): void {
  if (context.origin === null || !isSharedAuthOriginAllowed(context.origin)) {
    throw new OriginDeniedError('Local wallet', context.origin);
  }
  if (!isSharedAuthSiteId(payload.siteId)) {
    throw new Error(`Invalid siteId: ${String(payload.siteId)}`);
  }
}

/** An undecryptable record can never be used again, so it is deleted and reported to the caller. */
async function read(store: LocalWalletStore): Promise<Answer<'localWalletRead'>> {
  try {
    const wallet = await store.loadLocalWallet();
    return wallet === null
      ? { tag: 'none', value: undefined }
      : { tag: 'ok', value: { entropy: wallet.entropy, identity: wallet.identity } };
  } catch (error) {
    if (!(error instanceof LocalWalletUnreadableError)) {
      throw error;
    }
    await store.forgetLocalWallet();
    return { tag: 'unreadable', value: undefined };
  }
}

/** Serves the wallet to host pages on `serving`, over the page's own wallet store by default. */
export function serveLocalWallet(serving: ServingTransport, store: LocalWalletStore = pageWallet): void {
  const save: RequestHandler<'localWalletSave'> = async (payload, context) => {
    admit(payload, context);
    assertEntropy(payload.entropy);
    await store.saveLocalWallet(payload.entropy);
  };
  const cacheIdentity: RequestHandler<'localWalletIdentity'> = async (payload, context) => {
    admit(payload, context);
    await store.updateLocalWalletIdentity(payload.identity);
  };
  const forget: RequestHandler<'localWalletForget'> = async (payload, context) => {
    admit(payload, context);
    await store.forgetLocalWallet();
  };
  serving.handleRequest('localWalletRead', (payload, context) => {
    admit(payload, context);
    return read(store);
  });
  serving.handleRequest('localWalletSave', save);
  serving.handleRequest('localWalletIdentity', cacheIdentity);
  serving.handleRequest('localWalletForget', forget);
}
