// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves the local wallet to host pages. Same trust boundary as shared auth storage: host and landing origins of this
// root domain only, never product origins.

import {
  isSharedAuthOriginAllowed,
  isSharedAuthSiteId,
  protocolSchema,
  type ProtocolContext,
  type ProtocolServing,
} from '@dotli/protocol';
import {
  forgetLocalWallet,
  loadLocalWallet,
  LocalWalletUnreadableError,
  saveLocalWallet,
  updateLocalWalletIdentity,
  type LocalWalletStore,
} from '@dotli/storage';
import { type CallError, denied, err, type MethodTypes, ok, type Result } from '@dotli/transport';

const { wallet } = protocolSchema.traits;

type WalletRead = Extract<MethodTypes<typeof wallet.read>['response'], { tag: 'Ok' }>['value'];

const pageWallet: LocalWalletStore = { forgetLocalWallet, loadLocalWallet, saveLocalWallet, updateLocalWalletIdentity };

const ENTROPY_LENGTHS = new Set([16, 20, 24, 28, 32]);

function assertEntropy(value: Uint8Array): void {
  if (!ENTROPY_LENGTHS.has(value.length)) {
    throw new Error('Invalid local wallet entropy');
  }
}

/**
 * The refusal of a call whose origin does not check, or null to serve it. A site that does not check throws. Holds the
 * shared-auth trust boundary on any transport the wallet is served over.
 */
function refusalOf(payload: { siteId: string }, context: ProtocolContext): Result<never, CallError<never>> | null {
  if (context.origin === null || !isSharedAuthOriginAllowed(context.origin)) {
    return err(denied());
  }
  if (!isSharedAuthSiteId(payload.siteId)) {
    throw new Error(`Invalid siteId: ${String(payload.siteId)}`);
  }
  return null;
}

/** An undecryptable record can never be used again, so it is deleted and reported to the caller. */
async function read(store: LocalWalletStore): Promise<WalletRead> {
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
export function serveLocalWallet(serving: ProtocolServing, store: LocalWalletStore = pageWallet): void {
  serving.handleRequest(wallet.read, async (payload, context) => refusalOf(payload, context) ?? ok(await read(store)));
  serving.handleRequest(wallet.save, async (payload, context) => {
    const refusal = refusalOf(payload, context);
    if (refusal !== null) {
      return refusal;
    }
    assertEntropy(payload.entropy);
    await store.saveLocalWallet(payload.entropy);
    return ok();
  });
  serving.handleRequest(wallet.identity, async (payload, context) => {
    const refusal = refusalOf(payload, context);
    if (refusal !== null) {
      return refusal;
    }
    await store.updateLocalWalletIdentity(payload.identity);
    return ok();
  });
  serving.handleRequest(wallet.forget, async (payload, context) => {
    const refusal = refusalOf(payload, context);
    if (refusal !== null) {
      return refusal;
    }
    await store.forgetLocalWallet();
    return ok();
  });
}
