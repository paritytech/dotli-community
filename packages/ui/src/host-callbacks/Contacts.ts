import { blake2b } from "@noble/hashes/blake2.js";
import type { Bytes32 } from "@parity/truapi";
import { bytesToHex, hexToBytes } from "@parity/truapi/scale";
import type {
  ContactsPlatform,
  CoreStorage,
  CoreStorageKey,
  NativeChatContactsSnapshot,
  ProductContext,
} from "@parity/truapi-host";
import type { WorkerSigningHostRuntime } from "@parity/truapi-host/web";
import {
  blockingModalAbortError,
  throwIfAborted,
  type BlockingModalScope,
} from "../blocking-modal-queue";

const HEX32 = /^0x[0-9a-f]{64}$/;

type ContactsRuntime = Pick<
  WorkerSigningHostRuntime,
  "getNativeChatContacts" | "notifyContactsChanged"
>;

type ContactSnapshot = Omit<NativeChatContactsSnapshot, "contacts"> & {
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

  bind(
    runtime: ContactsRuntime,
    walletPublicKey: string,
    genesisHash: string,
  ): void {
    if (this.binding !== undefined || this.disposed) {
      throw new Error("Chat contacts runtime is already bound or disposed");
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
    this.generation.abort(blockingModalAbortError("Chat contacts changed"));
    this.generation = new AbortController();
    this.binding?.runtime.notifyContactsChanged();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.generation.abort(
      blockingModalAbortError("Chat contacts runtime closed"),
    );
  }

  async snapshot(signal: AbortSignal): Promise<ContactSnapshot> {
    this.assertCurrent();
    throwIfAborted(signal);
    const binding = this.binding;
    if (binding === undefined) {
      throw new Error("Chat contacts signing session is unavailable");
    }
    const snapshot = await abortable(
      binding.runtime.getNativeChatContacts(),
      signal,
    );
    this.assertCurrent();
    throwIfAborted(signal);
    if (
      snapshot.walletPublicKey !== binding.walletPublicKey ||
      snapshot.genesisHash !== binding.genesisHash
    ) {
      throw new Error(
        "Chat contacts do not belong to the active wallet and People network",
      );
    }
    for (const contact of snapshot.contacts) {
      assertHex32(contact.peerIdentity);
      if (
        contact.username !== undefined &&
        typeof contact.username !== "string"
      ) {
        throw new Error("Invalid native Chat contact name");
      }
    }
    // The native JSON identifiers have just been checked as canonical Bytes32.
    return snapshot as ContactSnapshot;
  }

  private assertCurrent(): void {
    if (this.disposed || !this.isCurrent()) {
      throw blockingModalAbortError("Chat contacts session changed");
    }
  }

  /** Observe only trusted typed keys, never encrypted Rust storage values.
   * The native getter shares the writer's lock and cannot read pre-commit state.
   */
  observeStorage(storage: CoreStorage): CoreStorage {
    const mutate = async (
      key: CoreStorageKey,
      operation: () => Promise<void>,
    ): Promise<void> => {
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
      writeCoreStorage: (key, value) =>
        mutate(key, () => storage.writeCoreStorage(key, value)),
      clearCoreStorage: (key) =>
        mutate(key, () => storage.clearCoreStorage(key)),
    };
  }
}

function affectsContacts(key: CoreStorageKey): boolean {
  return (
    key.tag === "NativeChatDevice" ||
    key.tag === "NativeChatProducts" ||
    key.tag === "PermissionAuthorization" ||
    key.tag === "ProductManifest" ||
    key.tag === "AuthSession"
  );
}

function assertHex32(value: string): void {
  if (typeof value !== "string" || !HEX32.test(value)) {
    throw new Error("Expected a canonical 32-byte contact identifier");
  }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = (): void => {
    reject(blockingModalAbortError(signal.reason));
  };
  signal.addEventListener("abort", abort, { once: true });
  void pending.then(
    (value) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        abort();
      } else {
        resolve(value);
      }
    },
    (error: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    },
  );
  if (signal.aborted) {
    signal.removeEventListener("abort", abort);
    abort();
  }
  return promise;
}

export function createContactsPlatform(
  directory: NativeChatContactsDirectory,
  modalScope: BlockingModalScope,
): { callbacks: Required<ContactsPlatform>; dispose(): void } {
  const lifetime = new AbortController();
  const operationSignal = (): AbortSignal =>
    AbortSignal.any([lifetime.signal, directory.signal]);
  return {
    dispose() {
      lifetime.abort(blockingModalAbortError("Contact picker host closed"));
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
          const handle = bytesToHex(
            blake2b(hexToBytes(contact.peerIdentity), { key, dkLen: 32 }),
          );
          if (wanted.has(handle)) {
            matches.set(handle, contact.peerIdentity);
          }
        }
        throwIfAborted(signal);
        return {
          accounts: lookup.handles.map((handle) => matches.get(handle)),
        };
      },
      async pickContact(product) {
        // Capture before enqueue: switching identity while waiting must not open
        // this product's old request under the replacement wallet.
        const signal = operationSignal();
        return abortable(
          modalScope.enqueue(async (queueSignal) => {
            const activeSignal = AbortSignal.any([signal, queueSignal]);
            const snapshot = await directory.snapshot(activeSignal);
            if (snapshot.contacts.length === 0) {
              return { tag: "NoContacts" as const };
            }
            const selected = await showContactPicker(
              product,
              snapshot.contacts,
              activeSignal,
            );
            throwIfAborted(activeSignal);
            if (selected === undefined) {
              return { tag: "Dismissed" as const };
            }
            const current = await directory.snapshot(activeSignal);
            if (
              !current.contacts.some(
                (contact) => contact.peerIdentity === selected,
              )
            ) {
              throw new Error(
                "The selected Chat contact is no longer available",
              );
            }
            return { tag: "Picked" as const, value: { account: selected } };
          }),
          signal,
        );
      },
    },
  };
}

function showContactPicker(
  product: ProductContext,
  contacts: ContactSnapshot["contacts"],
  signal: AbortSignal,
): Promise<Bytes32 | undefined> {
  throwIfAborted(signal);
  const { promise, resolve, reject } = Promise.withResolvers<
    Bytes32 | undefined
  >();
  const previousFocus = document.activeElement;
  const backdrop = document.createElement("div");
  backdrop.className = "signing-modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "signing-modal contacts-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "Choose a contact");
  const heading = document.createElement("h2");
  heading.textContent = "Choose a contact";
  const attribution = document.createElement("p");
  attribution.textContent = `${product.productId} is asking you to choose a Chat contact. Names and account identities stay in this host picker.`;
  const list = document.createElement("div");
  list.className = "contacts-picker-list";
  const cancel = document.createElement("button");
  cancel.className = "signing-btn-cancel";
  cancel.textContent = "Cancel";
  const footer = document.createElement("div");
  footer.className = "signing-modal-footer";
  footer.append(cancel);
  modal.append(heading, attribution, list, footer);
  backdrop.append(modal);

  let settled = false;
  const cleanup = (): void => {
    signal.removeEventListener("abort", abort);
    backdrop.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
      previousFocus.focus();
    }
  };
  const finish = (identity?: Bytes32): void => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    resolve(identity);
  };
  const abort = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    reject(blockingModalAbortError(signal.reason));
  };
  for (const contact of contacts) {
    const choice = document.createElement("button");
    choice.className = "signing-btn-secondary contacts-picker-choice";
    const name = document.createElement("span");
    name.textContent =
      contact.username !== undefined && contact.username !== ""
        ? contact.username
        : "Chat contact";
    const identity = document.createElement("span");
    identity.className = "contacts-picker-identity";
    identity.textContent = contact.peerIdentity;
    choice.append(name, identity);
    choice.addEventListener("click", () => {
      finish(contact.peerIdentity);
    });
    list.append(choice);
  }
  cancel.addEventListener("click", () => {
    finish();
  });
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      finish();
    }
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finish();
    } else if (event.key === "Tab") {
      const buttons = Array.from(modal.querySelectorAll("button"));
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  signal.addEventListener("abort", abort, { once: true });
  document.body.append(backdrop);
  list.querySelector("button")?.focus();
  return promise;
}
