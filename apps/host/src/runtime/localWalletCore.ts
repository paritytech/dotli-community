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
import { liteUsernameRefresh } from './createLiteUsernameRefresh.js';
import { reportLocalWalletFailure, type LocalWalletFailureReason } from './walletFailure.js';
import type { LocalWalletBoot } from './createWalletBoot.js';
import { watchIdentityAccount } from './watchIdentityAccount.js';

type CreateRuntime = typeof createWebWorkerPairingHostRuntime;

export type LocalWalletCoreBootParams = {
  /** Loads the signing host's worker. Rejects when it fails to load. */
  loadSigningWorker: () => Promise<{ default: new () => Worker }>;
  /** Settles with the name the network holds when it differs from the cached one, else with `undefined`. */
  refreshLiteUsername: (
    wallet: LocalWalletBoot,
    identityAccountId: Promise<string>,
  ) => Promise<string | null | undefined>;
  /** Reports the one failure nobody awaits, the re-activation after a name change. */
  reportFailure: (error: unknown, reason: LocalWalletFailureReason) => void;
};

/** One local wallet core to boot. */
type BootParams = {
  /** Builds the runtime over the signing worker. */
  create: CreateRuntime;
  /** What the core asks the page, passed on with the identity account caught from its auth states. */
  callbacks: WebWorkerHostCallbacks;
  /** The product's host config, which boots with the active TLD as its network suffix. */
  hostConfig: WebWorkerHostConfig;
  /** The stored wallet the core signs with. */
  wallet: LocalWalletBoot;
  /** False once the core is gone, so a late re-activation stands down. */
  isLive: () => boolean;
};

export type BootLocalWalletCore = ReturnType<typeof createLocalWalletCoreBoot>;

/** Returns the boot of a local wallet core. Never throws. */
export function createLocalWalletCoreBoot({
  loadSigningWorker,
  refreshLiteUsername,
  reportFailure,
}: LocalWalletCoreBootParams) {
  /** Resolves with the activated signing host. Rejects when it fails to boot or to activate. */
  async function boot({
    create,
    callbacks,
    hostConfig,
    wallet,
    isLive,
  }: BootParams): Promise<WorkerPairingHostRuntime> {
    const watched = watchIdentityAccount(callbacks);
    let runtime: WorkerPairingHostRuntime;
    try {
      const { default: SigningWorker } = await loadSigningWorker();
      runtime = await create(new SigningWorker(), watched.callbacks, {
        hostConfig: { ...hostConfig, networkSuffix: getActiveServicesConfig().dotns.TLD },
        role: 'signing',
      });
    } catch (error) {
      // The caller that asked for the core hears this and reports it, so only the count is kept here.
      m.count(S.WALLET_LOCAL_ACTIVATE, { outcome: 'error', reason: 'boot' });
      throw new Error('Local wallet core failed to boot', { cause: error });
    }
    try {
      await runtime.activateLocalSession(wallet.entropy, wallet.identity?.liteUsername ?? undefined);
    } catch (error) {
      runtime.dispose();
      m.count(S.WALLET_LOCAL_ACTIVATE, { outcome: 'error', reason: 'activate' });
      throw new Error('Local wallet activation failed', { cause: error });
    }
    m.count(S.WALLET_LOCAL_ACTIVATE, { outcome: 'ok' });
    log.event('local wallet activated', { flow: 'wallet' });

    // A repeated activation drops grants held only in memory, so it happens only when the name changed.
    void refreshLiteUsername(wallet, watched.identityAccountId)
      .then(async name => {
        if (name === undefined || !isLive()) {
          return;
        }
        await runtime.activateLocalSession(wallet.entropy, name ?? undefined);
        log.event('local wallet re-activated with a new username', { flow: 'wallet' });
      })
      .catch((error: unknown) => {
        reportFailure(error, 'reactivate');
      });

    return runtime;
  }

  return boot;
}

/** The page's local wallet core boot. */
export const bootLocalWalletCore: BootLocalWalletCore = createLocalWalletCoreBoot({
  loadSigningWorker,
  refreshLiteUsername: liteUsernameRefresh.refresh,
  reportFailure: reportLocalWalletFailure,
});
