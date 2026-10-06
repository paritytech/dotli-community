import { blake2b } from '@noble/hashes/blake2.js';
import type { Bytes32 } from '@parity/truapi';
import { bytesToHex, hexToBytes } from '@parity/truapi/scale';
import type {
  ContactsPlatform,
  CoreStorage,
  CoreStorageKey,
  NativeChatContactsSnapshot,
  PlacedContactLabels,
  ProductContext,
} from '@parity/truapi-host';
import type { WorkerSigningHostRuntime } from '@parity/truapi-host/web';
import { blockingModalAbortError, throwIfAborted, type BlockingModalScope } from '../blocking-modal-queue.js';
import { presentModal } from '../overlays/load.js';
import type { ContactLabelOverlay } from '../contacts/label-overlay.js';

const HEX32 = /^0x[0-9a-f]{64}$/;
const MAX_CONTACTS = 256;

type ContactsRuntime = Pick<WorkerSigningHostRuntime, 'getNativeChatContacts' | 'notifyContactsChanged'>;

type ContactSnapshot = Omit<NativeChatContactsSnapshot, 'contacts'> & {
  contacts: { peerIdentity: Bytes32; username?: string }[];
};

/** One immutable signing-runtime/wallet/People binding, shared by its providers. */
export class NativeChatContactsDirectory {
  private binding?: {
    runtime: ContactsRuntime;
    walletPublicKey: string;
    genesisHash: string;
  };
  private generation = new AbortController();
  private disposed = false;
  private readonly isCurrent: () => boolean;

  constructor(isCurrent: () => boolean) {
    this.isCurrent = isCurrent;
  }

  bind(runtime: ContactsRuntime, walletPublicKey: string, genesisHash: string): void {
    if (this.binding !== undefined || this.disposed) {
      throw new Error('Chat contacts runtime is already bound or disposed');
    }
    assertHex32(walletPublicKey);
    assertHex32(genesisHash);
    this.binding = { runtime, walletPublicKey, genesisHash };
  }

  get signal(): AbortSignal {
    this.assertCurrent();
    return this.generation.signal;
  }

  invalidate(): void {
    if (this.disposed) {
      return;
    }
    this.generation.abort(blockingModalAbortError('Chat contacts changed'));
    this.generation = new AbortController();
    this.binding?.runtime.notifyContactsChanged();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.generation.abort(blockingModalAbortError('Chat contacts runtime closed'));
  }

  async snapshot(signal: AbortSignal): Promise<ContactSnapshot> {
    this.assertCurrent();
    throwIfAborted(signal);
    const binding = this.binding;
    if (binding === undefined) {
      throw new Error('Chat contacts signing session is unavailable');
    }
    const snapshot = await abortable(binding.runtime.getNativeChatContacts(), signal);
    this.assertCurrent();
    throwIfAborted(signal);
    if (snapshot.walletPublicKey !== binding.walletPublicKey || snapshot.genesisHash !== binding.genesisHash) {
      throw new Error('Chat contacts do not belong to the active wallet and People network');
    }
    assertContactSnapshot(snapshot);
    return snapshot;
  }

  private assertCurrent(): void {
    if (this.disposed || !this.isCurrent()) {
      throw blockingModalAbortError('Chat contacts session changed');
    }
  }

  /** Observe only trusted typed keys, never encrypted Rust storage values.
   * The native getter shares the writer's lock and cannot read pre-commit state.
   */
  observeStorage(storage: CoreStorage): CoreStorage {
    const mutate = async (key: CoreStorageKey, operation: () => Promise<void>): Promise<void> => {
      if (!affectsContacts(key)) {
        return operation();
      }
      this.invalidate();
      try {
        await operation();
      } finally {
        this.invalidate();
      }
    };
    return {
      ...storage,
      writeCoreStorage: (key, value) => mutate(key, () => storage.writeCoreStorage(key, value)),
      clearCoreStorage: key => mutate(key, () => storage.clearCoreStorage(key)),
    };
  }
}

function affectsContacts(key: CoreStorageKey): boolean {
  return (
    key.tag === 'NativeChatDevice' ||
    key.tag === 'NativeChatProducts' ||
    key.tag === 'PermissionAuthorization' ||
    key.tag === 'ProductManifest' ||
    key.tag === 'AuthSession'
  );
}

function assertHex32(value: string): void {
  if (typeof value !== 'string' || !HEX32.test(value)) {
    throw new Error('Expected a canonical 32-byte contact identifier');
  }
}

function assertContactSnapshot(snapshot: NativeChatContactsSnapshot): asserts snapshot is ContactSnapshot {
  for (const contact of snapshot.contacts) {
    assertHex32(contact.peerIdentity);
    if (contact.username !== undefined && typeof contact.username !== 'string') {
      throw new Error('Invalid native Chat contact name');
    }
  }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = (): void => {
    reject(blockingModalAbortError(signal.reason));
  };
  signal.addEventListener('abort', abort, { once: true });
  void pending.then(
    value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        abort();
      } else {
        resolve(value);
      }
    },
    (error: unknown) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    },
  );
  if (signal.aborted) {
    signal.removeEventListener('abort', abort);
    abort();
  }
  return promise;
}

export function createContactsPlatform(
  directory: NativeChatContactsDirectory,
  modalScope: BlockingModalScope,
  labels?: ContactLabelOverlay,
): { callbacks: Required<ContactsPlatform>; dispose(): void } {
  const lifetime = new AbortController();
  const operationSignal = (): AbortSignal => AbortSignal.any([lifetime.signal, directory.signal]);
  let labelSnapshot: Promise<ReadonlyMap<Bytes32, string>> | undefined;
  let labelDirectorySignal: AbortSignal | undefined;
  let latestLabels: { placed: PlacedContactLabels; signal: AbortSignal } | undefined;

  const invalidateLabels = (): void => {
    labelSnapshot = undefined;
    labelDirectorySignal = undefined;
    const previous = latestLabels;
    const refresh =
      labels !== undefined && previous !== undefined && !previous.signal.aborted && !lifetime.signal.aborted;
    labels?.clear();
    latestLabels = refresh ? { placed: previous.placed, signal: labels.signal } : undefined;
    const request = latestLabels;
    if (request !== undefined) {
      // invalidate() installs the replacement directory generation after aborting
      // the old one. Navigation/empty placement/disposal may retire this request
      // before the microtask starts, in which case nothing is replayed.
      queueMicrotask(() => {
        void paintLabels(request).catch(() => {
          // Keep names hidden if the replacement session/read is unavailable.
          // A new placement or directory invalidation may request them again.
        });
      });
    }
  };

  const paintLabels = async (request: { placed: PlacedContactLabels; signal: AbortSignal }): Promise<void> => {
    if (labels === undefined || latestLabels !== request || request.signal.aborted || lifetime.signal.aborted) {
      return;
    }
    const directorySignal = directory.signal;
    if (labelDirectorySignal !== directorySignal) {
      labelDirectorySignal?.removeEventListener('abort', invalidateLabels);
      labelDirectorySignal = directorySignal;
      labelDirectorySignal.addEventListener('abort', invalidateLabels, {
        once: true,
      });
      labelSnapshot = undefined;
    }
    const signal = AbortSignal.any([lifetime.signal, directorySignal]);
    if (labelSnapshot === undefined) {
      const pending = directory.snapshot(signal).then(
        snapshot =>
          new Map(
            snapshot.contacts.map(contact => {
              const name = contact.username?.trim();
              return [contact.peerIdentity, name === undefined || name === '' ? contact.peerIdentity : name];
            }),
          ),
      );
      labelSnapshot = pending;
      void pending.catch(() => {
        // A failed read is not a reusable snapshot. Do not clear a newer read.
        if (labelSnapshot === pending) {
          labelSnapshot = undefined;
        }
      });
    }
    const activeSignal = AbortSignal.any([signal, request.signal]);
    const names = await abortable(labelSnapshot, activeSignal);
    throwIfAborted(activeSignal);
    if (latestLabels === request) {
      labels.place(request.placed, names);
    }
  };
  return {
    dispose() {
      labelDirectorySignal?.removeEventListener('abort', invalidateLabels);
      latestLabels = undefined;
      labelSnapshot = undefined;
      lifetime.abort(blockingModalAbortError('Contact picker host closed'));
      labels?.clear();
    },
    callbacks: {
      async contacts(lookup) {
        assertHex32(lookup.handleKey);
        for (const handle of lookup.handles) {
          assertHex32(handle);
        }
        const signal = operationSignal();
        const snapshot = await directory.snapshot(signal);
        const wanted = new Set(lookup.handles);
        const matches = new Map<Bytes32, Bytes32>();
        const key = hexToBytes(lookup.handleKey);
        for (const contact of snapshot.contacts) {
          const handle = bytesToHex(blake2b(hexToBytes(contact.peerIdentity), { key, dkLen: 32 }));
          if (wanted.has(handle)) {
            matches.set(handle, contact.peerIdentity);
          }
        }
        throwIfAborted(signal);
        return {
          accounts: lookup.handles.map(handle => matches.get(handle)),
        };
      },
      async pickContact(product) {
        // Capture before enqueue: switching identity while waiting must not open
        // this product's old request under the replacement wallet.
        const signal = operationSignal();
        return abortable(
          modalScope.enqueue(async queueSignal => {
            const activeSignal = AbortSignal.any([signal, queueSignal]);
            const snapshot = await directory.snapshot(activeSignal);
            if (snapshot.contacts.length === 0) {
              return { tag: 'NoContacts' as const };
            }
            const choices = await showContactPicker(product, snapshot.contacts, activeSignal);
            const selected = choices?.[0];
            throwIfAborted(activeSignal);
            if (selected === undefined) {
              return { tag: 'Dismissed' as const };
            }
            const current = await directory.snapshot(activeSignal);
            if (!current.contacts.some(contact => contact.peerIdentity === selected)) {
              throw new Error('The selected Chat contact is no longer available');
            }
            return { tag: 'Picked' as const, value: { account: selected } };
          }),
          signal,
        );
      },
      async pickContacts(product, selection) {
        const initial = selection.selected;
        if (initial.length > MAX_CONTACTS) {
          throw new Error('Too many selected Chat contacts');
        }
        initial.forEach(assertHex32);
        const selected = [...new Set(initial)];
        const signal = operationSignal();
        return abortable(
          modalScope.enqueue(async queueSignal => {
            const activeSignal = AbortSignal.any([signal, queueSignal]);
            const snapshot = await directory.snapshot(activeSignal);
            const available = new Set(snapshot.contacts.map(contact => contact.peerIdentity));
            if (selected.some(account => !available.has(account))) {
              throw new Error('A selected Chat contact is no longer available');
            }
            if (snapshot.contacts.length === 0) {
              return { tag: 'NoContacts' as const };
            }
            const accounts = await showContactPicker(product, snapshot.contacts, activeSignal, selected);
            throwIfAborted(activeSignal);
            if (accounts === undefined) {
              return { tag: 'Dismissed' as const };
            }
            const current = await directory.snapshot(activeSignal);
            const currentAccounts = new Set(current.contacts.map(contact => contact.peerIdentity));
            if (accounts.some(account => !currentAccounts.has(account))) {
              throw new Error('A selected Chat contact is no longer available');
            }
            return { tag: 'Picked' as const, value: { accounts } };
          }),
          signal,
        );
      },
      async placeContactLabels(_product, placed) {
        if (labels === undefined) {
          return false;
        }
        if (placed.labels.length === 0) {
          latestLabels = undefined;
          labels.clear();
          return true;
        }
        const request = { placed, signal: labels.signal };
        latestLabels = request;
        await paintLabels(request);
        return true;
      },
    },
  };
}

async function showContactPicker(
  product: ProductContext,
  contacts: ContactSnapshot['contacts'],
  signal: AbortSignal,
  initial?: readonly Bytes32[],
): Promise<Bytes32[] | undefined> {
  const multiple = initial !== undefined;
  // A duplicate native roster entry must not become a second consent control.
  const unique = new Map(contacts.map(contact => [contact.peerIdentity, contact]));
  const { result, selected } = await presentModal<Bytes32 | 'confirmed' | 'dismissed'>(
    {
      title: multiple ? 'Choose contacts' : 'Choose a contact',
      // Fields, not a notice: the prompt's notice is the reload callout.
      fields: [
        { label: 'Requesting product', value: product.productId },
        {
          label: 'Shared with the app',
          value: multiple
            ? "Only the chosen contacts' accounts. The list stays in this picker."
            : "Only the chosen contact's account. The list stays in this picker.",
        },
      ],
      choices: [...unique.values()].map(contact => {
        const name = contact.username?.trim();
        return {
          label: name === undefined || name === '' ? 'Chat contact' : name,
          result: contact.peerIdentity,
        };
      }),
      ...(initial === undefined ? {} : { selection: { selected: initial, limit: MAX_CONTACTS } }),
      buttons: multiple
        ? [
            { label: 'Cancel', variant: 'cancel', result: 'dismissed' },
            { label: 'Use selection', variant: 'primary', result: 'confirmed' },
          ]
        : [{ label: 'Cancel', variant: 'cancel', result: 'dismissed' }],
      dismissOnBackdrop: true,
      dismissResult: 'dismissed',
      fallbackResult: 'dismissed',
    },
    signal,
  );
  if (result === 'dismissed') {
    return undefined;
  }
  if (result !== 'confirmed') {
    return [result];
  }
  if (selected === undefined) {
    throw new Error('Contact selection was not confirmed');
  }
  return selected.map(account => {
    if (account === 'confirmed' || account === 'dismissed') {
      throw new Error('Invalid contact selection');
    }
    return account;
  });
}
