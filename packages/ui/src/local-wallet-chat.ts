// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Native Chat beside a local wallet core: its private records under the host frame's custody lease, its attachment
// sources, and the contacts the picker reads. A Polkadot App session has none of these; the phone holds its Chat.

import { getActiveServicesConfig, SITE_ID } from '@dotli/config';
import {
  CORE_CUSTODY_BUSY_ERROR,
  localWalletCustodyId,
  requestCoreCustody,
  type CoreCustodyOperation,
} from '@dotli/protocol';
import { log } from '@dotli/shared';
import { encodeCoreStorageKey } from '@parity/truapi-host';
import type { AuthState, ContactsPlatform, CoreStorage, CoreStorageKey } from '@parity/truapi-host';
import {
  createBrowserNativeChatFilesHost,
  type BrowserNativeChatFilesHost,
  type WorkerPairingHostRuntime,
} from '@parity/truapi-host/web';
import { bytesToHex } from '@parity/truapi/scale';
import type { BlockingModalScope } from './blocking-modal-queue.js';
import { createContactsPlatform, NativeChatContactsDirectory } from './host-callbacks/Contacts.js';
import type { LocalWalletBoot } from './wallet-boot.js';

export interface LocalWalletChat {
  /** The core's storage with native Chat's private slots held in custody. */
  coreStorage(storage: CoreStorage): CoreStorage;
  readonly nativeChatFiles: BrowserNativeChatFilesHost;
  /** Contacts callbacks whose picker belongs to one modal scope. */
  openContacts(scope: BlockingModalScope): { callbacks: Required<ContactsPlatform>; dispose(): void };
  authStateChanged(state: AuthState): void;
  /** Binds the contacts directory to the activated core. */
  activated(runtime: WorkerPairingHostRuntime): void;
  /** Releases custody, after a still-pending acquisition if need be. */
  dispose(): void;
}

/** Wallet-scoped by their own keys, unlike the core's other slots. */
function isCustodySlot(key: CoreStorageKey): boolean {
  return (
    key.tag === 'MainPurseCoinage' ||
    key.tag === 'NativeChatDevice' ||
    key.tag === 'NativeChatFileChunk' ||
    key.tag === 'NativeChatProducts'
  );
}

function custodyKey(key: CoreStorageKey): string {
  return bytesToHex(encodeCoreStorageKey(key)).slice(2);
}

/** Acquisition starts now, so booting never waits on it; only native Chat's own operations do. */
export function createLocalWalletChat(wallet: LocalWalletBoot, isLive: () => boolean): LocalWalletChat {
  const lease = localWalletCustodyId(wallet.entropy).then(async id => {
    const acquired = await requestCoreCustody(SITE_ID, { action: 'acquire', wallet: id });
    if (typeof acquired !== 'string') {
      throw new Error('Native Chat custody was not acquired');
    }
    return acquired;
  });
  lease.catch((error: unknown) => {
    if (error instanceof Error && error.name === CORE_CUSTODY_BUSY_ERROR) {
      log.warn('[dot.li] native Chat stays in the tab that already holds it:', error.message);
    } else {
      log.warn('[dot.li] native Chat custody is unavailable:', error);
    }
  });
  let disposed = false;
  const custody = async (
    operation: (lease: string) => CoreCustodyOperation,
  ): Promise<string | Uint8Array | Blob | undefined> => {
    if (disposed) {
      throw new Error('Native Chat custody was released');
    }
    return requestCoreCustody(SITE_ID, operation(await lease));
  };

  const genesis = getActiveServicesConfig().people.genesis;
  const directory = new NativeChatContactsDirectory(
    () => !disposed && isLive() && genesis === getActiveServicesConfig().people.genesis,
  );
  let walletPublicKey: string | undefined;

  const nativeChatFiles = createBrowserNativeChatFilesHost({
    async putSources(sources) {
      await custody(token => ({ action: 'putSources', lease: token, sources: [...sources] }));
    },
    async readSource(sourceId) {
      const blob = await custody(token => ({ action: 'readSource', lease: token, sourceId }));
      if (blob !== undefined && !(blob instanceof Blob)) {
        throw new Error('Invalid private Chat source');
      }
      return blob;
    },
    async releaseSource(sourceId) {
      await custody(token => ({ action: 'releaseSource', lease: token, sourceId }));
    },
  });

  return {
    coreStorage(storage) {
      return directory.observeStorage({
        async readCoreStorage(key) {
          if (!isCustodySlot(key)) {
            return storage.readCoreStorage(key);
          }
          const result = await custody(token => ({ action: 'read', lease: token, key: custodyKey(key) }));
          if (result !== undefined && !(result instanceof Uint8Array)) {
            throw new Error('Invalid private custody record');
          }
          return result;
        },
        async writeCoreStorage(key, value) {
          if (!isCustodySlot(key)) {
            await storage.writeCoreStorage(key, value);
            return;
          }
          await custody(token => ({ action: 'write', lease: token, key: custodyKey(key), value }));
        },
        async clearCoreStorage(key) {
          if (!isCustodySlot(key)) {
            await storage.clearCoreStorage(key);
            return;
          }
          await custody(token => ({ action: 'clear', lease: token, key: custodyKey(key) }));
        },
      });
    },
    nativeChatFiles,
    openContacts(scope) {
      return createContactsPlatform(directory, scope);
    },
    authStateChanged(state) {
      if (state.tag === 'Connected') {
        walletPublicKey = state.value.publicKey;
      }
      directory.invalidate();
    },
    activated(runtime) {
      if (walletPublicKey === undefined) {
        log.warn('[dot.li] local wallet activation reported no public key, so Chat contacts are unavailable');
        return;
      }
      directory.bind(runtime, walletPublicKey, genesis);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      directory.dispose();
      nativeChatFiles.dispose();
      void lease
        .then(token => requestCoreCustody(SITE_ID, { action: 'release', lease: token }))
        .catch(() => {
          // Never acquired, or the host frame already ended the lease.
        });
    },
  };
}
