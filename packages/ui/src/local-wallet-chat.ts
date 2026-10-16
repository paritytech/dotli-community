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
import type { ContactLabelOverlay } from './contacts/label-overlay.js';
import type { LocalWalletBoot } from './wallet-boot.js';

export interface LocalWalletChat {
  /** The core's storage with native Chat's private slots held in custody. */
  coreStorage(storage: CoreStorage): CoreStorage;
  readonly nativeChatFiles: BrowserNativeChatFilesHost;
  /** The native Chat contacts directory, which Profile also reads for contact names. */
  readonly contactsDirectory: NativeChatContactsDirectory;
  /** Contacts callbacks whose picker belongs to one modal scope, with names drawn on `labels` if given. */
  openContacts(
    scope: BlockingModalScope,
    labels?: ContactLabelOverlay,
  ): { callbacks: Required<ContactsPlatform>; dispose(): void };
  authStateChanged(state: AuthState): void;
  /** Binds the contacts directory to the activated core. */
  activated(runtime: WorkerPairingHostRuntime): void;
  /** Releases custody, after a still-pending acquisition if need be. */
  dispose(): void;
}

/**
 * A Chat app's Chat access, which the core checks before any product page lists that app's contacts. The other grants
 * are only read on their own product's page and stay in its storage.
 */
function isChatAccessGrant(key: CoreStorageKey): boolean {
  return key.tag === 'PermissionAuthorization' && key.value.request.tag === 'ChatAuthority';
}

/**
 * Native Chat's records, the profile disclosure and received references, and the host channel's peer keys, all
 * wallet-scoped by their own keys, plus the Chat access grants. A profile is shared from one product page and relayed
 * or shown from another, so none of these can stay with the page that wrote them.
 */
function isCustodySlot(key: CoreStorageKey): boolean {
  return (
    key.tag === 'MainPurseCoinage' ||
    key.tag === 'NativeChatDevice' ||
    key.tag === 'NativeChatFileChunk' ||
    key.tag === 'NativeChatProducts' ||
    key.tag === 'ProfileDisclosure' ||
    key.tag === 'ProfileReferencesReceived' ||
    key.tag === 'ProfilePersonalReferencesReceived' ||
    key.tag === 'HostChannelPeers' ||
    isChatAccessGrant(key)
  );
}

/** A grant's key names only its product, so custody keys it under the wallet too. */
function custodyKey(key: CoreStorageKey, walletId: string): string {
  const encoded = bytesToHex(encodeCoreStorageKey(key)).slice(2);
  return isChatAccessGrant(key) ? walletId + encoded : encoded;
}

/** Acquisition starts now, so booting never waits on it; only native Chat's own operations do. */
export function createLocalWalletChat(wallet: LocalWalletBoot, isLive: () => boolean): LocalWalletChat {
  const walletId = localWalletCustodyId(wallet.entropy);
  const lease = walletId.then(async id => {
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
          const storageKey = custodyKey(key, await walletId);
          const result = await custody(token => ({ action: 'read', lease: token, key: storageKey }));
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
          const storageKey = custodyKey(key, await walletId);
          await custody(token => ({ action: 'write', lease: token, key: storageKey, value }));
        },
        async clearCoreStorage(key) {
          if (!isCustodySlot(key)) {
            await storage.clearCoreStorage(key);
            return;
          }
          const storageKey = custodyKey(key, await walletId);
          await custody(token => ({ action: 'clear', lease: token, key: storageKey }));
        },
      });
    },
    nativeChatFiles,
    contactsDirectory: directory,
    openContacts(scope, labels) {
      return createContactsPlatform(directory, scope, labels);
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
