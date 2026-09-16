import { DEBUG, SITE_ID } from "@dotli/config/config";
import { getNetwork, type Network } from "@dotli/config/network";
import type { LocalIdentity } from "@parity/truapi-host/web";
import { bytesToHex, hexToBytes } from "@parity/truapi/scale";
import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { encodeCoreStorageKey } from "@parity/truapi-host";
import type {
  CoreStorage,
  CoreStorageKey,
  SessionUiInfo,
} from "@parity/truapi-host";
import { SHARED_CORE_SESSION_KEY } from "@dotli/protocol/auth-storage";
import {
  clearSharedAuthStorage,
  readSharedAuthStorage,
  subscribeSharedAuthStorage,
  writeSharedAuthStorage,
  requestSharedWallet,
  subscribeSharedWallet,
} from "@dotli/protocol/client";
import { log } from "@dotli/shared/log";
import type { SharedWalletState } from "@dotli/protocol/wallet-storage";
import { dispatchAuthState } from "./AuthState";

const LOCAL_CHANGE_EVENT = "dotli:truapi-session-store-changed";
const CORE_LOCAL_STORAGE_PREFIX = "dotli:core:";

// JSON cache of the last connected UI state the core reported via
// `authStateChanged`. Lives in shared auth storage next to the opaque
// root-domain session blob so boot-time rehydration never has to decode the
// blob itself.
const UI_STATE_CACHE_KEY = `${SHARED_CORE_SESSION_KEY}:ui-state`;
export const LOCAL_WALLET_ENABLED_KEY = "dotli:local-wallet-enabled";
const EXPERIMENTAL_CORE_STORAGE_PREFIX = "dotli:experimental-core:";
export const LOCAL_WALLET_REVISION_KEY = "dotli:local-wallet-revision";
const VERIFIED_LOCAL_IDENTITY_PREFIX = "dotli:verified-local-identity:";

export interface LocalWalletContext {
  network: Network;
  revision: string | null;
}

export interface LocalWalletIdentityBinding extends LocalWalletContext {
  identityAccountId: string;
}

export function localWalletContext(): LocalWalletContext {
  return {
    network: getNetwork(),
    revision: localStorage.getItem(LOCAL_WALLET_REVISION_KEY),
  };
}

export function isCurrentLocalWallet(context: LocalWalletContext): boolean {
  return (
    !walletMutationPending &&
    isExperimentalWalletActive() &&
    context.network === getNetwork() &&
    context.revision === localStorage.getItem(LOCAL_WALLET_REVISION_KEY)
  );
}

// Include the network in the grant namespace as well as the replacement
// revision. Switching chains must not silently reuse another chain's grants.
function localWalletStorageGeneration(): string {
  return `${getNetwork()}:${localStorage.getItem(LOCAL_WALLET_REVISION_KEY) ?? "initial"}`;
}

function verifiedLocalIdentityKey(binding: LocalWalletIdentityBinding): string {
  return `${VERIFIED_LOCAL_IDENTITY_PREFIX}${binding.network}:${binding.identityAccountId}`;
}

function boundLocalIdentityKey(binding: LocalWalletIdentityBinding): string {
  return `${EXPERIMENTAL_CORE_STORAGE_PREFIX}${binding.revision ?? "initial"}:${verifiedLocalIdentityKey(binding)}`;
}

function parseVerifiedLocalIdentity(
  raw: string | null,
  binding: LocalWalletIdentityBinding,
  requireRevision: boolean,
): LocalIdentity | undefined {
  if (raw === null) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (
      record.version !== 1 ||
      record.network !== binding.network ||
      record.identityAccountId !== binding.identityAccountId ||
      !/^0x[0-9a-f]{64}$/.test(binding.identityAccountId) ||
      (requireRevision && record.revision !== binding.revision) ||
      (record.liteUsername !== undefined &&
        (typeof record.liteUsername !== "string" ||
          record.liteUsername.trim() === ""))
    ) {
      return undefined;
    }
    return {
      identityAccountId: binding.identityAccountId,
      ...(typeof record.liteUsername === "string"
        ? { liteUsername: record.liteUsername }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Restore only after native activation has identified this exact wallet.
 * The shared record contains public, previously chain-verified metadata, not
 * entropy or grants. A product origin binds the record to the current wallet
 * revision only after deriving the same identity natively.
 */
export async function readVerifiedLocalIdentity(
  binding: LocalWalletIdentityBinding,
): Promise<LocalIdentity | undefined> {
  if (!isCurrentLocalWallet(binding)) {
    return undefined;
  }
  let identity: LocalIdentity | undefined;
  try {
    identity = parseVerifiedLocalIdentity(
      await readSharedAuthStorage(SITE_ID, verifiedLocalIdentityKey(binding)),
      binding,
      false,
    );
  } catch {
    identity = parseVerifiedLocalIdentity(
      localStorage.getItem(boundLocalIdentityKey(binding)),
      binding,
      true,
    );
  }
  if (!isCurrentLocalWallet(binding)) {
    return undefined;
  }
  if (identity !== undefined) {
    localStorage.setItem(
      boundLocalIdentityKey(binding),
      JSON.stringify({
        version: 1,
        ...binding,
        ...identity,
      }),
    );
  }
  return identity;
}

/** Called only with a successful native chain lookup/registration result. */
export async function writeVerifiedLocalIdentity(
  binding: LocalWalletIdentityBinding,
  identity: LocalIdentity,
): Promise<void> {
  if (!isCurrentLocalWallet(binding)) {
    throw new Error(
      "Test wallet changed while checking its username. Try again with the current wallet.",
    );
  }
  const encoded = JSON.stringify({ version: 1, ...binding, ...identity });
  if (parseVerifiedLocalIdentity(encoded, binding, true) === undefined) {
    throw new Error("Native identity did not match the active test wallet.");
  }
  // Commit under the protocol wallet lock, so a late native registration
  // cannot publish metadata after this identity has been retired remotely.
  await writeSharedAuthStorage(
    SITE_ID,
    verifiedLocalIdentityKey(binding),
    encoded,
    binding.revision,
  );
  if (!isCurrentLocalWallet(binding)) {
    throw new Error("Test wallet changed while saving its username.");
  }
  localStorage.setItem(boundLocalIdentityKey(binding), encoded);
}

export function onVerifiedLocalIdentityChanged(
  listener: () => void,
): () => void {
  return subscribeSharedAuthStorage((change) => {
    if (
      change.siteId === SITE_ID &&
      change.key.startsWith(VERIFIED_LOCAL_IDENTITY_PREFIX)
    ) {
      listener();
    }
  });
}

export function isExperimentalWalletActive(): boolean {
  return DEBUG && localStorage.getItem(LOCAL_WALLET_ENABLED_KEY) === "1";
}

function emitLocalChange(): void {
  window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT));
}

export interface TruapiSessionUiState {
  connected: boolean;
  publicKey?: string;
  identityAccountId?: string;
  liteUsername?: string;
  fullUsername?: string;
  primaryUsername?: string;
}

/** Last native display metadata, not proof of a current authenticated session. */
export type LocalWalletDisplay = Omit<TruapiSessionUiState, "connected"> & {
  identityAccountId: string;
};

/** Convert the core's decoded session fields into the rendering-friendly
 * shape (hex-encoded keys) the topbar and UI-state cache use. */
export function toSessionUiState(info: SessionUiInfo): TruapiSessionUiState {
  const primaryUsername = info.fullUsername ?? info.liteUsername;
  return {
    connected: true,
    publicKey: info.publicKey,
    ...(info.identityAccountId !== undefined
      ? { identityAccountId: info.identityAccountId }
      : {}),
    ...(info.liteUsername !== undefined
      ? { liteUsername: info.liteUsername }
      : {}),
    ...(info.fullUsername !== undefined
      ? { fullUsername: info.fullUsername }
      : {}),
    ...(primaryUsername !== undefined ? { primaryUsername } : {}),
  };
}

/** Persist public display metadata from native auth transitions. Mobile uses
 * shared session storage; the experimental wallet uses origin-local storage. */
export async function writeUiStateCache(
  detail: TruapiSessionUiState,
): Promise<void> {
  try {
    // Never replace a mobile session's shared UI cache with a test identity.
    if (isExperimentalWalletActive()) {
      const key = `${EXPERIMENTAL_CORE_STORAGE_PREFIX}${localWalletStorageGeneration()}:ui-state`;
      if (!detail.connected) {
        localStorage.removeItem(key);
      } else if (!walletMutationPending) {
        localStorage.setItem(key, JSON.stringify(detail));
      }
      return;
    }
    if (detail.connected) {
      await writeSharedAuthStorage(
        SITE_ID,
        UI_STATE_CACHE_KEY,
        JSON.stringify(detail),
      );
    } else {
      await clearSharedAuthStorage(SITE_ID, UI_STATE_CACHE_KEY);
    }
  } catch (err) {
    log.warn("[dot.li] session UI cache write failed:", err);
  }
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/** Validate a parsed UI-state cache blob field by field. The cache is
 * host-written same-origin data, but it can be stale from a different code
 * version or partially corrupted, so a malformed blob degrades to null
 * (bare connected state) rather than being cast into the typed shape. */
function parseUiStateCache(parsed: unknown): TruapiSessionUiState | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const state = parsed as Record<string, unknown>;
  if (
    state.connected !== true ||
    !isOptionalString(state.publicKey) ||
    !isOptionalString(state.identityAccountId) ||
    !isOptionalString(state.liteUsername) ||
    !isOptionalString(state.fullUsername) ||
    !isOptionalString(state.primaryUsername)
  ) {
    return null;
  }
  return {
    connected: true,
    ...(state.publicKey !== undefined ? { publicKey: state.publicKey } : {}),
    ...(state.identityAccountId !== undefined
      ? { identityAccountId: state.identityAccountId }
      : {}),
    ...(state.liteUsername !== undefined
      ? { liteUsername: state.liteUsername }
      : {}),
    ...(state.fullUsername !== undefined
      ? { fullUsername: state.fullUsername }
      : {}),
    ...(state.primaryUsername !== undefined
      ? { primaryUsername: state.primaryUsername }
      : {}),
  };
}

/**
 * Read display-only metadata synchronously before native startup. This never
 * activates a wallet or publishes auth; only the native owner can verify it.
 */
export function readLocalWalletDisplay(): LocalWalletDisplay | undefined {
  try {
    if (walletMutationPending || !isExperimentalWalletActive()) {
      return undefined;
    }
    const raw = localStorage.getItem(
      `${EXPERIMENTAL_CORE_STORAGE_PREFIX}${localWalletStorageGeneration()}:ui-state`,
    );
    if (raw === null) {
      return undefined;
    }
    const state = parseUiStateCache(JSON.parse(raw));
    if (
      state?.identityAccountId === undefined ||
      !/^0x[0-9a-f]{64}$/.test(state.identityAccountId)
    ) {
      return undefined;
    }
    const { connected: _connected, identityAccountId, ...metadata } = state;
    return { ...metadata, identityAccountId };
  } catch {
    return undefined;
  }
}

async function readUiStateCache(): Promise<TruapiSessionUiState | null> {
  try {
    const raw = await readSharedAuthStorage(SITE_ID, UI_STATE_CACHE_KEY);
    if (raw === null) {
      return null;
    }
    return parseUiStateCache(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Re-emit cached UI state for the persisted same-origin Mobile session, if any.
 * Used at boot so a reload shows the Mobile badge before any core
 * instance runs. Only emits when a persisted session blob actually exists;
 * without a cached state it degrades to a bare `connected: true`.
 */
export async function emitPersistedSessionUiState(): Promise<void> {
  try {
    await initializeLocalWalletState();
  } catch (error) {
    const walletWasConfigured = (() => {
      try {
        return (
          localStorage.getItem(LOCAL_WALLET_ENABLED_KEY) === "1" ||
          localStorage.getItem(LOCAL_WALLET_REVISION_KEY) !== null
        );
      } catch {
        // If storage itself is unavailable, we cannot safely claim there was
        // no wallet to restore.
        return true;
      }
    })();
    if (
      walletWasConfigured ||
      (error instanceof Error && error.name === "WalletConflictError")
    ) {
      throw error;
    }
  }
  // Only the persistent signing owner can publish experimental identity.
  // Disk metadata and secret availability are not native session proof.
  if (isExperimentalWalletActive()) {
    return;
  }

  let hasCoreSession: boolean;
  try {
    const raw = await readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY);
    hasCoreSession = raw !== null && raw !== "";
  } catch {
    return;
  }
  if (!hasCoreSession) {
    return;
  }
  dispatchAuthState({
    tag: "Connected",
    session: (await readUiStateCache()) ?? { connected: true },
  });
}

export function createSessionStoreAdapters(): CoreStorage {
  // Capture the mode for the lifetime of these callbacks. Switching modes
  // reloads the page; pending writes must not cross into the other identity.
  const experimental = isExperimentalWalletActive();
  const generation = experimental ? localWalletStorageGeneration() : null;
  return {
    async readCoreStorage(key) {
      return readCoreStorageValue(key, experimental, generation);
    },
    async writeCoreStorage(key, value) {
      await writeCoreStorageValue(key, value, experimental, generation);
    },
    async clearCoreStorage(key) {
      if (!experimental || generation === localWalletStorageGeneration()) {
        await clearCoreStorageValue(key, experimental, generation);
      }
    },
  };
}

async function readCoreStorageValue(
  key: CoreStorageKey,
  experimental = false,
  generation: string | null = null,
): Promise<Uint8Array | undefined> {
  if (
    experimental &&
    (walletMutationPending || generation !== localWalletStorageGeneration())
  ) {
    return undefined;
  }
  if (key.tag === "AuthSession" && !experimental) {
    let raw: string | null;
    try {
      raw = await readSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY);
    } catch (err) {
      log.warn("[dot.li] shared auth session read failed:", err);
      return undefined;
    }
    if (raw === null || raw === "") {
      return undefined;
    }
    return decodeStoredBytes(raw, "shared auth session");
  }
  const raw = localStorage.getItem(
    coreLocalStorageKey(key, experimental, generation),
  );
  return raw === null
    ? undefined
    : await decodeCoreStorageValue(key, raw, experimental, generation);
}

function decodeStoredBytes(
  raw: string,
  description: string,
): Uint8Array | undefined {
  try {
    return hexToBytes(raw);
  } catch (err) {
    log.warn(`[dot.li] ignoring corrupt ${description}:`, err);
    return undefined;
  }
}

async function writeCoreStorageValue(
  key: CoreStorageKey,
  value: Uint8Array,
  experimental = false,
  generation: string | null = null,
): Promise<void> {
  if (key.tag === "AuthSession" && !experimental) {
    await writeSharedAuthStorage(
      SITE_ID,
      SHARED_CORE_SESSION_KEY,
      bytesToHex(value),
    );
    emitLocalChange();
    return;
  }
  const encoded = await encodeCoreStorageValue(key, value);
  if (
    !experimental ||
    (!walletMutationPending && generation === localWalletStorageGeneration())
  ) {
    localStorage.setItem(
      coreLocalStorageKey(key, experimental, generation),
      encoded,
    );
  }
}

async function clearCoreStorageValue(
  key: CoreStorageKey,
  experimental = false,
  generation: string | null = null,
): Promise<void> {
  if (key.tag === "AuthSession" && !experimental) {
    await clearSharedAuthStorage(SITE_ID, SHARED_CORE_SESSION_KEY);
    await writeUiStateCache({ connected: false });
    emitLocalChange();
    return;
  }
  localStorage.removeItem(coreLocalStorageKey(key, experimental, generation));
}

function coreLocalStorageKey(
  key: CoreStorageKey,
  experimental = false,
  generation: string | null = null,
): string {
  if (experimental) {
    return (
      EXPERIMENTAL_CORE_STORAGE_PREFIX +
      (generation === null ? "" : `${generation}:`) +
      hexNoPrefix(encodeCoreStorageKey(key))
    );
  }
  switch (key.tag) {
    case "PairingDeviceIdentity":
      return `${CORE_LOCAL_STORAGE_PREFIX}pairing-device-identity`;
    case "PermissionAuthorization":
      return `${CORE_LOCAL_STORAGE_PREFIX}permission:${hexNoPrefix(
        encodeCoreStorageKey(key),
      )}`;
    case "AllowanceKeys":
      return `${CORE_LOCAL_STORAGE_PREFIX}allowance-keys:${key.value.sessionId}`;
    case "AutoSigningKey":
      return `${CORE_LOCAL_STORAGE_PREFIX}auto-signing:${hexNoPrefix(
        encodeCoreStorageKey(key),
      )}`;
    // Wallet-bound capabilities for the active pairing: one slot, unlike the
    // legacy per-product `AutoSigningKey` above.
    case "AutoSigningKeys":
      return `${CORE_LOCAL_STORAGE_PREFIX}auto-signing-keys`;
    // Keyed by root public key so several rings can coexist. The snapshot is
    // public, so it is not treated as secret material below.
    case "RingVrfRegistry":
      return `${CORE_LOCAL_STORAGE_PREFIX}ring-vrf-registry:${hexNoPrefix(
        encodeCoreStorageKey(key),
      )}`;
    case "StatementRenewalTargets":
      return `${CORE_LOCAL_STORAGE_PREFIX}statement-renewal-targets`;
    case "LastProcessedPairingStatement":
      return `${CORE_LOCAL_STORAGE_PREFIX}last-processed-pairing-statement`;
    case "AuthSession":
      return `${CORE_LOCAL_STORAGE_PREFIX}auth-session`;
    // Peers address this device by the public counterpart, so the slot name
    // must not move with the session.
    case "DeviceEncryptionKey":
      return `${CORE_LOCAL_STORAGE_PREFIX}device-encryption-key`;
    // Keyed by session and product together: pairing again re-asks the
    // Account Holder, so one session's answer must not be read back for
    // another.
    case "ProductSubtree":
      return `${CORE_LOCAL_STORAGE_PREFIX}product-subtree:${hexNoPrefix(
        encodeCoreStorageKey(key),
      )}`;
    // The ledger bounds replays for one wallet and peer pair, so the whole
    // triple has to discriminate the slot.
    case "SsoResponderRequestLedger":
      return `${CORE_LOCAL_STORAGE_PREFIX}sso-responder-ledger:${hexNoPrefix(
        encodeCoreStorageKey(key),
      )}`;
  }
}

function storesSecretMaterial(key: CoreStorageKey): boolean {
  return (
    key.tag === "AllowanceKeys" ||
    key.tag === "AutoSigningKey" ||
    key.tag === "AutoSigningKeys" ||
    key.tag === "DeviceEncryptionKey"
  );
}

async function encodeCoreStorageValue(
  key: CoreStorageKey,
  value: Uint8Array,
): Promise<string> {
  if (storesSecretMaterial(key)) {
    const nonce = crypto.getRandomValues(
      new Uint8Array(CORE_SECRET_NONCE_LENGTH),
    );
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce },
        await coreSecretStorageKey(),
        new Uint8Array(value),
      ),
    );
    const stored = new Uint8Array(nonce.length + ciphertext.length);
    stored.set(nonce);
    stored.set(ciphertext, nonce.length);
    return ENCRYPTED_VALUE_PREFIX + bytesToHex(stored);
  }
  return bytesToHex(value);
}

async function decodeCoreStorageValue(
  key: CoreStorageKey,
  raw: string,
  experimental = false,
  generation: string | null = null,
): Promise<Uint8Array | undefined> {
  if (!storesSecretMaterial(key)) {
    return decodeStoredBytes(raw, `core storage ${key.tag}`);
  }
  if (!raw.startsWith(ENCRYPTED_VALUE_PREFIX)) {
    // Slots written before at-rest encryption shipped hold the plain key
    // bytes. Re-persist encrypted so the plaintext copy doesn't outlive
    // this read.
    const bytes = decodeStoredBytes(raw, `core storage ${key.tag}`);
    if (bytes === undefined) {
      return undefined;
    }
    log.warn(`[dot.li] re-encrypting legacy plaintext core storage ${key.tag}`);
    await writeCoreStorageValue(key, bytes, experimental, generation);
    return bytes;
  }
  const bytes = decodeStoredBytes(
    raw.slice(ENCRYPTED_VALUE_PREFIX.length),
    `core storage ${key.tag}`,
  );
  if (bytes === undefined) {
    return undefined;
  }
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, CORE_SECRET_NONCE_LENGTH) },
        await coreSecretStorageKey(),
        bytes.slice(CORE_SECRET_NONCE_LENGTH),
      ),
    );
  } catch (err) {
    // The slot was written under a key we no longer hold (IndexedDB
    // cleared while localStorage survived, or a session-ephemeral fallback
    // key) or the bytes are corrupt. Drop it: returning the raw bytes
    // would hand ciphertext to the core as key material.
    log.warn(`[dot.li] dropping undecryptable core storage ${key.tag}:`, err);
    localStorage.removeItem(coreLocalStorageKey(key, experimental, generation));
    return undefined;
  }
}

// Marks a slot as holding the encrypted format. Legacy plaintext slots are
// bare hex, so the prefix cleanly separates "must decrypt" from "migrate":
// a decrypt failure never falls back to treating ciphertext as plaintext.
const ENCRYPTED_VALUE_PREFIX = "enc1:";

// Standard AES-GCM nonce length. A fresh random nonce is drawn per write and
// stored as the ciphertext prefix: GCM security collapses if a (key, nonce)
// pair is ever reused.
const CORE_SECRET_NONCE_LENGTH = 12;

const KEY_DB_NAME = "dotli-core";
const KEY_DB_STORE = "keys";
const CORE_SECRET_KEY_ID = "allowance-keys";
const LOCAL_WALLET_SECRET_ID = "local-wallet-entropy-v1";

export interface LocalWalletSecret {
  secret: Uint8Array;
  created: boolean;
}

let sharedWalletState: SharedWalletState | undefined;
let walletInitialization: Promise<void> | undefined;
let walletHydrated = false;
let walletSubscriptionBound = false;
let walletMutationPending = false;

/** Cache metadata only. The shared protocol record remains authoritative. */
function acceptSharedWalletState(
  state: SharedWalletState,
  notify = false,
): void {
  if (
    sharedWalletState !== undefined &&
    state.version < sharedWalletState.version
  ) {
    return;
  }
  sharedWalletState = state;
  const revision = localStorage.getItem(LOCAL_WALLET_REVISION_KEY);
  const enabled = localStorage.getItem(LOCAL_WALLET_ENABLED_KEY);
  const nextEnabled = state.enabled ? "1" : null;
  if (revision !== state.revision) {
    clearExperimentalCoreStorage();
  }
  if (state.revision === null) {
    localStorage.removeItem(LOCAL_WALLET_REVISION_KEY);
  } else {
    localStorage.setItem(LOCAL_WALLET_REVISION_KEY, state.revision);
  }
  if (nextEnabled === null) {
    localStorage.removeItem(LOCAL_WALLET_ENABLED_KEY);
  } else {
    localStorage.setItem(LOCAL_WALLET_ENABLED_KEY, nextEnabled);
  }
  if (notify && walletHydrated) {
    // Update both guards before invoking the bridge, which disposes old signers.
    const key =
      revision !== state.revision
        ? LOCAL_WALLET_REVISION_KEY
        : enabled !== nextEnabled
          ? LOCAL_WALLET_ENABLED_KEY
          : null;
    if (key !== null) {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key,
          oldValue: key === LOCAL_WALLET_REVISION_KEY ? revision : enabled,
          newValue:
            key === LOCAL_WALLET_REVISION_KEY ? state.revision : nextEnabled,
          storageArea: localStorage,
        }),
      );
    }
  }
}

function currentWalletVersion(): number {
  if (sharedWalletState === undefined) {
    throw new Error("Shared wallet state is unavailable");
  }
  return sharedWalletState.version;
}

/**
 * Hydrate from host.<root>, then migrate an origin-local encrypted wallet only
 * if the shared store is uninitialized (or already holds exactly that wallet).
 * A tombstone is initialized; migration can never undo a deletion.
 */
export function initializeLocalWalletState(): Promise<void> {
  if (!DEBUG) {
    return Promise.resolve();
  }
  if (!walletSubscriptionBound) {
    walletSubscriptionBound = true;
    subscribeSharedWallet((state) => {
      acceptSharedWalletState(state, true);
    });
    // A suspended page may have missed a broadcast. Reconcile before reuse.
    window.addEventListener("pageshow", () => {
      if (!walletHydrated) {
        return;
      }
      void requestSharedWallet(SITE_ID, { action: "state" })
        .then(({ state }) => {
          acceptSharedWalletState(state, true);
        })
        .catch((error: unknown) => {
          log.warn("[dot.li] Shared wallet refresh failed:", error);
        });
    });
  }
  walletInitialization ??= (async () => {
    const wasEnabled = localStorage.getItem(LOCAL_WALLET_ENABLED_KEY) === "1";
    const { state } = await requestSharedWallet(SITE_ID, { action: "state" });
    acceptSharedWalletState(state);
    const legacy = await readLegacyLocalWallet();
    if (legacy !== undefined) {
      try {
        const migrated = await requestSharedWallet(SITE_ID, {
          action: "migrate",
          expectedVersion: state.version,
          secret: legacy.secret,
          enabled: wasEnabled,
        });
        acceptSharedWalletState(migrated.state);
        await removeLegacyLocalWallet(legacy.encoded);
      } finally {
        legacy.secret.fill(0);
      }
    }
    walletHydrated = true;
  })().catch((error: unknown) => {
    walletInitialization = undefined;
    throw error;
  });
  return walletInitialization;
}

/** Strict recovery reader: malformed or undecryptable entropy is never erased. */
async function readLegacyLocalWallet(): Promise<
  { secret: Uint8Array<ArrayBuffer>; encoded: string } | undefined
> {
  const db = await openKeyDb();
  try {
    const encoded = await idbGetString(db, LOCAL_WALLET_SECRET_ID);
    if (encoded === undefined) {
      return undefined;
    }
    if (!encoded.startsWith(ENCRYPTED_VALUE_PREFIX)) {
      throw new Error(
        "Saved local wallet has an unknown format; its data has been preserved.",
      );
    }
    const bytes = decodeStoredBytes(
      encoded.slice(ENCRYPTED_VALUE_PREFIX.length),
      "local wallet entropy",
    );
    const key = await idbGetKey(db);
    if (
      bytes === undefined ||
      bytes.length <= CORE_SECRET_NONCE_LENGTH ||
      key === undefined
    ) {
      throw new Error(
        "Saved local wallet cannot be decrypted; its data has been preserved.",
      );
    }
    const secret = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, CORE_SECRET_NONCE_LENGTH) },
        key,
        bytes.slice(CORE_SECRET_NONCE_LENGTH),
      ),
    );
    if (secret.length < 16 || secret.length > 32 || secret.length % 4 !== 0) {
      secret.fill(0);
      throw new Error(
        "Saved local wallet entropy is invalid; its data has been preserved.",
      );
    }
    return { secret, encoded };
  } finally {
    db.close();
  }
}

/** Snapshot the legacy slot before an explicit replacement, without decrypting it. */
async function legacyWalletCiphertext(): Promise<string | undefined> {
  const db = await openKeyDb();
  try {
    return await idbGetString(db, LOCAL_WALLET_SECRET_ID);
  } finally {
    db.close();
  }
}

/** Delete only the legacy ciphertext actually migrated, not a concurrent import. */
async function removeLegacyLocalWallet(
  expected: string | undefined,
): Promise<void> {
  const db = await openKeyDb();
  try {
    const { promise, resolve, reject } = Promise.withResolvers<undefined>();
    const tx = db.transaction(KEY_DB_STORE, "readwrite");
    const store = tx.objectStore(KEY_DB_STORE);
    const request = store.get(LOCAL_WALLET_SECRET_ID);
    let conflict = false;
    request.onsuccess = () => {
      if (request.result !== undefined && request.result !== expected) {
        conflict = true;
        tx.abort();
      } else {
        store.delete(LOCAL_WALLET_SECRET_ID);
      }
    };
    tx.oncomplete = () => {
      resolve(undefined);
    };
    tx.onabort = tx.onerror = () => {
      const error = new Error(
        conflict
          ? "Local wallet changed during migration. Export its preserved recovery phrase before replacing it."
          : "Local wallet removal failed",
      );
      if (conflict) {
        error.name = "WalletConflictError";
      }
      reject(error);
    };
    await promise;
  } finally {
    db.close();
  }
}

export async function setLocalWalletEnabled(active: boolean): Promise<void> {
  if (!DEBUG) {
    throw new Error("Experimental wallets require a debug build");
  }
  const expectedVersion = sharedWalletState?.version;
  await initializeLocalWalletState();
  const result = await requestSharedWallet(SITE_ID, {
    action: "enabled",
    expectedVersion: expectedVersion ?? currentWalletVersion(),
    enabled: active,
  });
  acceptSharedWalletState(result.state);
}

/** Caller must zero its page-memory entropy after transferring it to a signer. */
export async function readLocalWalletSecret(): Promise<Uint8Array | undefined> {
  if (!DEBUG) {
    return undefined;
  }
  await initializeLocalWalletState();
  const result = await requestSharedWallet(SITE_ID, { action: "read" });
  if (
    sharedWalletState !== undefined &&
    result.state.version < sharedWalletState.version
  ) {
    result.secret?.fill(0);
    throw new Error("Wallet changed while reading its entropy. Try again.");
  }
  acceptSharedWalletState(result.state, true);
  return result.secret;
}

export async function createLocalWalletSecret(): Promise<LocalWalletSecret> {
  if (!DEBUG) {
    throw new Error("Experimental wallets require a debug build");
  }
  const expectedVersion = sharedWalletState?.version;
  await initializeLocalWalletState();
  const result = await requestSharedWallet(SITE_ID, {
    action: "create",
    expectedVersion: expectedVersion ?? currentWalletVersion(),
  });
  if (
    sharedWalletState !== undefined &&
    result.state.version < sharedWalletState.version
  ) {
    result.secret?.fill(0);
    throw new Error("Wallet changed during creation. Try again.");
  }
  acceptSharedWalletState(result.state);
  if (result.secret === undefined) {
    throw new Error("Shared wallet creation returned no entropy");
  }
  return { secret: result.secret, created: result.created === true };
}

/**
 * Encode the existing entropy, not a BIP-39 seed. Native activation uses
 * substrate-bip39::mini_secret_from_entropy(entropy, "") and sr25519
 * Ed25519 expansion; mnemonicToSeed would silently change this identity.
 * The caller must clear the displayed phrase when it is no longer needed.
 */
export async function exportLocalWalletMnemonic(): Promise<string> {
  if (!DEBUG) {
    throw new Error("Experimental wallets require a debug build");
  }
  let secret: Uint8Array | undefined;
  try {
    secret = await readLocalWalletSecret();
  } catch (error) {
    // Migration conflicts must remain recoverable through the existing export UI.
    if (!(error instanceof Error) || error.name !== "WalletConflictError") {
      throw error;
    }
    secret = (await readLegacyLocalWallet())?.secret;
  }
  if (secret === undefined) {
    throw new Error(
      "No test wallet is stored. Enable one or import a phrase first.",
    );
  }
  try {
    return entropyToMnemonic(secret, wordlist);
  } finally {
    secret.fill(0);
  }
}

/**
 * Import checksum-validated English BIP-39 entropy (12/15/18/21/24 words).
 * No passphrase or custom derivation path is supported. The callback retires
 * old signers before the revision-checked shared replacement.
 */
export async function importLocalWalletMnemonic(
  mnemonic: string,
  beforeReplace?: () => void,
): Promise<void> {
  if (!DEBUG) {
    throw new Error("Experimental wallets require a debug build");
  }
  let secret: Uint8Array<ArrayBuffer>;
  try {
    secret = mnemonicToEntropy(mnemonic.trim().replace(/\s+/g, " "), wordlist);
  } catch {
    // Library errors may contain input words. Never propagate them to UI/logs.
    throw new Error(
      "Invalid recovery phrase. Use 12, 15, 18, 21 or 24 English BIP-39 words with a valid checksum; no passphrase or derivation path.",
    );
  }
  if (walletMutationPending) {
    secret.fill(0);
    throw new Error("Another wallet change is already in progress");
  }
  walletMutationPending = true;
  const startingVersion = sharedWalletState?.version;
  try {
    const legacy = await legacyWalletCiphertext();
    try {
      await initializeLocalWalletState();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "WalletConflictError" ||
        sharedWalletState === undefined
      ) {
        throw error;
      }
    }
    const expectedVersion = startingVersion ?? currentWalletVersion();
    beforeReplace?.();
    const result = await requestSharedWallet(SITE_ID, {
      action: "import",
      expectedVersion,
      secret,
    });
    acceptSharedWalletState(result.state);
    await removeLegacyLocalWallet(legacy);
    walletHydrated = true;
    walletInitialization = Promise.resolve();
  } finally {
    secret.fill(0);
    walletMutationPending = false;
  }
}

/** Permanently delete the shared wallet, retaining its anti-resurrection tombstone. */
export async function deleteLocalWalletSecret(): Promise<void> {
  if (!DEBUG) {
    throw new Error("Experimental wallets require a debug build");
  }
  if (walletMutationPending) {
    throw new Error("Another wallet change is already in progress");
  }
  walletMutationPending = true;
  const expectedVersion = sharedWalletState?.version;
  try {
    const legacy = await legacyWalletCiphertext();
    try {
      await initializeLocalWalletState();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "WalletConflictError" ||
        sharedWalletState === undefined
      ) {
        throw error;
      }
    }
    const result = await requestSharedWallet(SITE_ID, {
      action: "delete",
      expectedVersion: expectedVersion ?? currentWalletVersion(),
    });
    acceptSharedWalletState(result.state);
    await removeLegacyLocalWallet(legacy);
    walletHydrated = true;
    walletInitialization = Promise.resolve();
  } finally {
    walletMutationPending = false;
  }
}

function clearExperimentalCoreStorage(): void {
  // Retired workers cannot publish old grants into the replacement namespace.
  // Revision itself is exclusively assigned by the authoritative shared store.
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index);
    if (key?.startsWith(EXPERIMENTAL_CORE_STORAGE_PREFIX) === true) {
      localStorage.removeItem(key);
    }
  }
}

let coreSecretKeyPromise: Promise<CryptoKey> | undefined;

/**
 * The at-rest key for core signing-secret slots: a random per-install AES key
 * generated non-extractable and persisted in IndexedDB, so the key material
 * itself can never be read out of the browser's crypto implementation — a
 * key derived from bundle data would be computable by anyone. If IndexedDB
 * is unavailable the key degrades to session-ephemeral: values written then
 * fail to decrypt after a reload and are dropped like any corrupt slot.
 */
function coreSecretStorageKey(): Promise<CryptoKey> {
  coreSecretKeyPromise ??= loadOrCreateCoreSecretKey().catch((err: unknown) => {
    log.warn(
      "[dot.li] falling back to a session-ephemeral core-secret storage key:",
      err,
    );
    return generateCoreSecretKey();
  });
  return coreSecretKeyPromise;
}

function generateCoreSecretKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function loadOrCreateCoreSecretKey(): Promise<CryptoKey> {
  const db = await openKeyDb();
  try {
    const existing = await idbGetKey(db);
    if (existing !== undefined) {
      return existing;
    }
    const key = await generateCoreSecretKey();
    try {
      await idbAddKey(db, key);
      return key;
    } catch (err) {
      // add() rejects when the slot is already taken: another tab won the
      // race, so adopt its key instead of splitting the install across two.
      const winner = await idbGetKey(db);
      if (winner !== undefined) {
        return winner;
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

function openKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(KEY_DB_STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("indexedDB open failed"));
    };
  });
}

function idbGetKey(db: IDBDatabase): Promise<CryptoKey | undefined> {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(KEY_DB_STORE)
      .objectStore(KEY_DB_STORE)
      .get(CORE_SECRET_KEY_ID);
    request.onsuccess = () => {
      const value: unknown = request.result;
      resolve(isCryptoKey(value) ? value : undefined);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("indexedDB get failed"));
    };
  });
}

function idbAddKey(db: IDBDatabase, key: CryptoKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_DB_STORE, "readwrite");
    tx.objectStore(KEY_DB_STORE).add(key, CORE_SECRET_KEY_ID);
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("indexedDB add failed"));
    };
    // A commit-time abort (e.g. QuotaExceededError) fires only `abort`;
    // without this the promise never settles and, being memoized, would
    // hang every allowance read/write for the session.
    tx.onabort = () => {
      reject(tx.error ?? new Error("indexedDB add aborted"));
    };
  });
}
function idbGetString(
  db: IDBDatabase,
  key: string,
): Promise<string | undefined> {
  const { promise, resolve, reject } = Promise.withResolvers<
    string | undefined
  >();
  const request = db
    .transaction(KEY_DB_STORE)
    .objectStore(KEY_DB_STORE)
    .get(key);
  request.onsuccess = () => {
    resolve(typeof request.result === "string" ? request.result : undefined);
  };
  request.onerror = () => {
    reject(request.error ?? new Error("indexedDB string read failed"));
  };
  return promise;
}

/** `instanceof CryptoKey` is unreliable across realms (and the global is
 * missing under happy-dom), so validate the stored record structurally. */
function isCryptoKey(value: unknown): value is CryptoKey {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as CryptoKey).type === "secret"
  );
}

function hexNoPrefix(bytes: Uint8Array): string {
  return bytesToHex(bytes).slice(2);
}

export function onStoredSessionChanged(listener: () => void): () => void {
  const onLocalChange = (): void => {
    listener();
  };
  window.addEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
  const unsubscribeShared = subscribeSharedAuthStorage((change) => {
    if (change.siteId === SITE_ID && change.key === SHARED_CORE_SESSION_KEY) {
      listener();
    }
  });
  return () => {
    window.removeEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
    unsubscribeShared();
  };
}
