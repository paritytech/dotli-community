// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves the local wallet to host pages. Same trust boundary as shared auth storage: host and landing origins of this
// root domain only, never product origins.

import {
  isSharedAuthOriginAllowed,
  isSharedAuthSiteId,
  type ProtocolContext,
  type ProtocolSchema,
  type ProtocolTransport,
} from '@dotli/protocol';
import {
  forgetLocalWallet,
  loadLocalWallet,
  LocalWalletUnreadableError,
  saveLocalWallet,
  updateLocalWalletIdentity,
  type LocalWalletStore,
} from '@dotli/storage';
import { denied, err, ok, type CallError, type MethodTypes, type Result } from '@dotli/transport';

type WalletRead = Extract<MethodTypes<ProtocolSchema, 'wallet', 'read'>['response'], { ok: true }>['value'];

const pageWallet: LocalWalletStore = { forgetLocalWallet, loadLocalWallet, saveLocalWallet, updateLocalWalletIdentity };

const ENTROPY_LENGTHS = new Set([16, 20, 24, 28, 32]);

function assertEntropy(value: Uint8Array): void {
  if (!ENTROPY_LENGTHS.has(value.length)) {
    throw new Error('Invalid local wallet entropy');
  }
}

/**
 * Runs `use` once the call's origin and site check, or answers the call's refusal. Holds the shared-auth trust boundary
 * on any transport the wallet is served over.
 */
async function admitted<T>(
  payload: { siteId: string },
  context: ProtocolContext,
  use: () => Promise<T>,
): Promise<Result<T, CallError<never>>> {
  if (context.origin === null || !isSharedAuthOriginAllowed(context.origin)) {
    return err(denied());
  }
  if (!isSharedAuthSiteId(payload.siteId)) {
    throw new Error(`Invalid siteId: ${String(payload.siteId)}`);
  }
  return ok(await use());
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
export function serveLocalWallet(serving: ProtocolTransport, store: LocalWalletStore = pageWallet): void {
  serving.handleRequest('wallet', 'read', (payload, context) => admitted(payload, context, () => read(store)));
  serving.handleRequest('wallet', 'save', (payload, context) =>
    admitted(payload, context, async () => {
      assertEntropy(payload.entropy);
      await store.saveLocalWallet(payload.entropy);
    }),
  );
  serving.handleRequest('wallet', 'identity', (payload, context) =>
    admitted(payload, context, () => store.updateLocalWalletIdentity(payload.identity)),
  );
  serving.handleRequest('wallet', 'forget', (payload, context) =>
    admitted(payload, context, () => store.forgetLocalWallet()),
  );
}
