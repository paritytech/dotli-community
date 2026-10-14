// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Boots a page core as a signing host on the shared local wallet. The core keeps the session in memory only, so
// every core activates on every boot.

import type {
  createWebWorkerPairingHostRuntime,
  WebWorkerHostCallbacks,
  WebWorkerHostConfig,
  WorkerPairingHostRuntime,
} from '@parity/truapi-host/web';
import { getActiveServicesConfig } from '@dotli/config';
import { m, spans as S } from '@dotli/metrics';
import { log } from '@dotli/shared';
import { loadSigningWorker } from '../lazy.js';
import { refreshLiteUsername } from './local-wallet-identity.js';
import { reportLocalWalletFailure, type LocalWalletBoot, type LocalWalletFailureReason } from './wallet-boot.js';

type CreateRuntime = typeof createWebWorkerPairingHostRuntime;

/** The core tells its identity account only through the auth state it reports, so the account is caught there. */
export function watchIdentityAccount(callbacks: WebWorkerHostCallbacks): {
  callbacks: WebWorkerHostCallbacks;
  identityAccountId: Promise<string>;
} {
  let found: (identityAccountId: string) => void = () => undefined;
  const identityAccountId = new Promise<string>(resolve => {
    found = resolve;
  });
  return {
    callbacks: {
      ...callbacks,
      auth: {
        authStateChanged(state) {
          callbacks.auth.authStateChanged(state);
          if (state.tag === 'Connected' && state.value.identityAccountId !== undefined) {
            found(state.value.identityAccountId);
          }
        },
      },
    },
    identityAccountId,
  };
}

export interface LocalWalletCoreDeps {
  loadSigningWorker: () => Promise<{ default: new () => Worker }>;
  /** Settles with the name the network holds when it differs from the cached one, else with `undefined`. */
  refreshLiteUsername: (
    wallet: LocalWalletBoot,
    identityAccountId: Promise<string>,
  ) => Promise<string | null | undefined>;
  reportFailure: (error: unknown, reason: LocalWalletFailureReason) => void;
}

export type BootLocalWalletCore = (
  create: CreateRuntime,
  callbacks: WebWorkerHostCallbacks,
  hostConfig: WebWorkerHostConfig,
  wallet: LocalWalletBoot,
  isLive: () => boolean,
) => Promise<WorkerPairingHostRuntime>;

export function createLocalWalletCoreBoot(deps: LocalWalletCoreDeps): BootLocalWalletCore {
  return async (create, callbacks, hostConfig, wallet, isLive) => {
    const watched = watchIdentityAccount(callbacks);
    let runtime: WorkerPairingHostRuntime;
    try {
      const { default: SigningWorker } = await deps.loadSigningWorker();
      runtime = await create(new SigningWorker(), watched.callbacks, {
        hostConfig: { ...hostConfig, networkSuffix: getActiveServicesConfig().dotns.TLD },
        role: 'signing',
      });
    } catch (error) {
      deps.reportFailure(error, 'boot');
      throw new Error('Local wallet core failed to boot', { cause: error });
    }
    try {
      await runtime.activateLocalSession(wallet.entropy, wallet.identity?.liteUsername ?? undefined);
    } catch (error) {
      runtime.dispose();
      deps.reportFailure(error, 'activate');
      throw new Error('Local wallet activation failed', { cause: error });
    }
    m.count(S.WALLET_LOCAL_ACTIVATE, { outcome: 'ok' });
    log.event('local wallet activated', { flow: 'wallet' });

    // A repeated activation drops grants held only in memory, so it happens only when the name changed.
    void deps
      .refreshLiteUsername(wallet, watched.identityAccountId)
      .then(async name => {
        if (name === undefined || !isLive()) {
          return;
        }
        await runtime.activateLocalSession(wallet.entropy, name ?? undefined);
        log.event('local wallet re-activated with a new username', { flow: 'wallet' });
      })
      .catch((error: unknown) => {
        deps.reportFailure(error, 'reactivate');
      });

    return runtime;
  };
}

export const bootLocalWalletCore: BootLocalWalletCore = createLocalWalletCoreBoot({
  loadSigningWorker,
  refreshLiteUsername,
  reportFailure: reportLocalWalletFailure,
});
