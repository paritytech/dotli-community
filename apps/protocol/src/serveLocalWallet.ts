// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Serves the local wallet to host pages. The transport it is served on holds the shared-auth trust boundary: host and
// landing origins of this root domain, never product origins.

import { isLocalWalletEntropy, protocolSchema, type LocalWalletRead, type ProtocolServing } from '@dotli/protocol';
import { localWallet, LocalWalletUnreadableError, type LocalWalletStore } from '@dotli/storage';

import { answerAdmitted } from './answerAdmitted.js';

type Params = {
  /** Where the wallet is served. */
  serving: ProtocolServing;
  /**
   * Hears each save and forget, and each compare-and-forget that forgot. An identity is the same wallet, and an
   * unreadable record a read drops was already lost to every tab.
   */
  onChange: (siteId: string) => void;
  /** The wallet record. Defaults to the page's own. */
  store?: LocalWalletStore;
};

const { wallet } = protocolSchema.sections;

/**
 * Serves the wallet to host pages on `serving`. A call that fails is answered with its failure.
 *
 * Returns a stop that removes the five handlers, so a later wallet call is refused as unserved, while a call in flight
 * runs to its end. The stop is safe to call twice.
 */
export function serveLocalWallet({ serving, onChange, store = localWallet }: Params): () => void {
  const stops = [
    serving.handleRequest(wallet.read, payload => answerAdmitted(payload, () => readLocalWallet(store))),
    serving.handleRequest(wallet.save, payload =>
      answerAdmitted(payload, async (): Promise<undefined> => {
        if (!isLocalWalletEntropy(payload.entropy)) {
          throw new Error('Invalid local wallet entropy');
        }
        await store.save(payload.entropy, payload.identity);
        onChange(payload.siteId);
      }),
    ),
    serving.handleRequest(wallet.identity, payload =>
      answerAdmitted(payload, async (): Promise<undefined> => {
        await store.updateIdentity(payload.identity);
      }),
    ),
    serving.handleRequest(wallet.forget, payload =>
      answerAdmitted(payload, async (): Promise<undefined> => {
        await store.forget();
        onChange(payload.siteId);
      }),
    ),
    serving.handleRequest(wallet.forgetIf, payload =>
      answerAdmitted(payload, async () => {
        const forgot = await store.forgetIf(payload.version);
        if (forgot) {
          onChange(payload.siteId);
        }
        return forgot;
      }),
    ),
  ];
  return function stop(): void {
    for (const remove of stops) {
      remove();
    }
  };
}

/** An undecryptable record can never be used again, so it is deleted and reported to the caller. */
async function readLocalWallet(store: LocalWalletStore): Promise<LocalWalletRead> {
  try {
    const wallet = await store.load();
    return wallet === null
      ? { tag: 'none', value: undefined }
      : { tag: 'ok', value: { entropy: wallet.entropy, identity: wallet.identity, version: wallet.version } };
  } catch (error) {
    if (!(error instanceof LocalWalletUnreadableError)) {
      throw error;
    }
    // Only the record that failed, so a wallet another tab saved since stays.
    await store.forgetIf(error.version);
    return { tag: 'unreadable', value: undefined };
  }
}
