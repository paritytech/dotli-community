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
import { loadSigningWorker } from './lazy.js';
import { refreshLiteUsername } from './local-wallet-identity.js';
import { holdPermissionsInMemory } from './signing-host-permissions.js';
import { reportLocalWalletFailure, type LocalWalletBoot } from './wallet-boot.js';

type CreateRuntime = typeof createWebWorkerPairingHostRuntime;

export async function bootLocalWalletCore(
  create: CreateRuntime,
  callbacks: WebWorkerHostCallbacks,
  hostConfig: WebWorkerHostConfig,
  wallet: LocalWalletBoot,
  isLive: () => boolean,
): Promise<WorkerPairingHostRuntime> {
  let runtime: WorkerPairingHostRuntime;
  try {
    const { default: SigningWorker } = await loadSigningWorker();
    runtime = await create(new SigningWorker(), callbacks, {
      hostConfig: { ...hostConfig, networkSuffix: getActiveServicesConfig().dotns.TLD },
      role: 'signing',
    });
  } catch (error) {
    reportLocalWalletFailure(error, 'boot');
    throw new Error('Local wallet core failed to boot', { cause: error });
  }
  holdPermissionsInMemory(runtime);
  try {
    await runtime.activateLocalSession(wallet.entropy, wallet.identity?.liteUsername ?? undefined);
  } catch (error) {
    runtime.dispose();
    reportLocalWalletFailure(error, 'activate');
    throw new Error('Local wallet activation failed', { cause: error });
  }
  m.count(S.WALLET_LOCAL_ACTIVATE, { outcome: 'ok' });
  log.event('local wallet activated', { flow: 'wallet' });

  // A repeated activation drops grants held only in memory, so it happens only when the name changed.
  void refreshLiteUsername(wallet)
    .then(async name => {
      if (name === undefined || !isLive()) {
        return;
      }
      await runtime.activateLocalSession(wallet.entropy, name ?? undefined);
      log.event('local wallet re-activated with a new username', { flow: 'wallet' });
    })
    .catch((error: unknown) => {
      reportLocalWalletFailure(error, 'reactivate');
    });

  return runtime;
}
