// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves the local wallet to host pages. Same trust boundary as shared auth storage: host and landing origins of this
// root domain only, never product origins.

import { protocolSchema, type LocalWalletRead, type ProtocolContext, type ProtocolServing } from '@dotli/protocol';
import {
  forgetLocalWallet,
  loadLocalWallet,
  LocalWalletUnreadableError,
  saveLocalWallet,
  updateLocalWalletIdentity,
  type LocalWalletStore,
} from '@dotli/storage';
import { ok, type Failure, type ResultPayload } from '@dotli/transport';

import { admitSite } from './shared-store-handler.js';

const { wallet } = protocolSchema.traits;

const pageWallet: LocalWalletStore = { forgetLocalWallet, loadLocalWallet, saveLocalWallet, updateLocalWalletIdentity };

const ENTROPY_LENGTHS = new Set([16, 20, 24, 28, 32]);

function assertEntropy(value: Uint8Array): void {
  if (!ENTROPY_LENGTHS.has(value.length)) {
    throw new Error('Invalid local wallet entropy');
  }
}

/** An undecryptable record can never be used again, so it is deleted and reported to the caller. */
async function read(store: LocalWalletStore): Promise<LocalWalletRead> {
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

/** Runs `write` once the call's origin and site check, or answers the call's refusal. */
async function admittedWrite(
  payload: { siteId: string },
  context: ProtocolContext,
  write: () => Promise<void>,
): Promise<ResultPayload<undefined, Failure>> {
  const site = admitSite(payload, context);
  if (!site.success) {
    return site;
  }
  await write();
  return ok();
}

/** Serves the wallet to host pages on `serving`, over the page's own wallet store by default. */
export function serveLocalWallet(serving: ProtocolServing, store: LocalWalletStore = pageWallet): void {
  serving.handleRequest(wallet.read, async (payload, context) => {
    const site = admitSite(payload, context);
    return site.success ? ok(await read(store)) : site;
  });
  serving.handleRequest(wallet.save, (payload, context) =>
    admittedWrite(payload, context, () => {
      assertEntropy(payload.entropy);
      return store.saveLocalWallet(payload.entropy);
    }),
  );
  serving.handleRequest(wallet.identity, (payload, context) =>
    admittedWrite(payload, context, () => store.updateLocalWalletIdentity(payload.identity)),
  );
  serving.handleRequest(wallet.forget, (payload, context) =>
    admittedWrite(payload, context, () => store.forgetLocalWallet()),
  );
}
