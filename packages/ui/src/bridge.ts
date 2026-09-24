// dot.li TrUAPI host bridge
//
// Boots a WASM TrUAPI core instance and connects it to a sandboxed
// product iframe via `@parity/truapi-host`. Each render swaps its product
// runtime. In experimental mode a separate host-owned signing runtime keeps
// wallet identity and username operations alive independently of products.
//
// Nested dApp-in-dApp composition is not modeled as separate Rust runtimes,
// sessions, product identities, or storage namespaces. Any future nested
// traffic must share the top-level core/provider context.

import {
  AllocatableResource,
  createClient,
  createTransport,
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_REQUEST,
  MESSAGE_TYPE_RESPONSE,
  scale,
  VersionedHostRequestLoginError,
  VersionedHostRequestLoginRequest,
  VersionedHostRequestLoginResponse,
  type HostRequestLoginResponse as LoginResponse,
  type TrUApiClient,
  type WireProvider as Provider,
  createMessagePortProvider,
} from "@parity/truapi";
import { ACCOUNT_REQUEST_LOGIN } from "@parity/truapi/wire-table";
import type { InspectorProduct } from "@dotli/truapi-debug/panel";
import { DEBUG, sandboxOriginForLabel } from "@dotli/config/config";
import {
  SANDBOX_CONTRACT_PARAMS,
  SANDBOX_SCHEMA_VERSION,
} from "@dotli/config/host-sandbox-contract";
import { getBackend, getCacheSettings } from "@dotli/config/mode";
import {
  getActiveServicesConfig,
  getNetwork,
  withActiveTld,
} from "@dotli/config/network";
import { getResolutionId, m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import { chatCapabilityFor } from "@dotli/shared/chat-capability";
import { log } from "@dotli/shared/log";
import {
  emitDotliDebugEvent,
  hasDotliDebugListeners,
} from "@dotli/truapi-debug/dotli-debug-bus";
import type { TrUApiProductProvider } from "@parity/truapi-host";
import type { AuthState, PairingHostAdmin } from "@parity/truapi-host";
import type {
  LocalIdentity,
  LocalIdentityProgress,
  WorkerPairingHostRuntime,
  WorkerSigningHostRuntime,
} from "@parity/truapi-host/web";
import {
  ALL_PERMISSIONS,
  authorizationRequest,
  fromAuthorizationStatus,
  buildAllowAttribute,
  registerPermissionAuthorizationProvider,
} from "./permissions";
import { createHostCallbacks } from "./host-callbacks/handlers";
import { dispatchAuthState } from "./host-callbacks/AuthState";
import {
  CameraInputCancelledError,
  CameraInputPermissionError,
  scanCameraUr,
} from "./mediated-input-camera";
import {
  MediatedInputHost,
  validatedMediatedInputRequest,
} from "./mediated-input-host";
import { decidePromptPermission } from "./host-callbacks/PromptPermission";
import { createSubmitRateLimiter } from "./host-callbacks/rate-limit";
import {
  onStoredSessionChanged,
  createLocalWalletSecret,
  readLocalWalletSecret,
  deleteLocalWalletSecret,
  exportLocalWalletMnemonic,
  importLocalWalletMnemonic,
  isExperimentalWalletActive,
  initializeLocalWalletState,
  setLocalWalletEnabled,
  onVerifiedLocalIdentityChanged,
  localWalletContext,
  isCurrentLocalWallet,
  readVerifiedLocalIdentity,
  readLocalWalletDisplay,
  writeVerifiedLocalIdentity,
  type LocalWalletIdentityBinding,
  LOCAL_WALLET_ENABLED_KEY,
  LOCAL_WALLET_REVISION_KEY,
} from "./host-callbacks/SessionStore";
import { LoginRequestError } from "./login-request-error";
import { productIframeBox } from "./product-iframe-box";
import { installPolkaVmViewInsetsRelay } from "./polkavm-view-insets";
import { createTruapiRuntimeConfig, labelToProductId } from "./runtime-config";
import { describeWireFrame } from "./debug-wire-describe";
import type { BlockingModalCoordinator } from "./blocking-modal-queue";
import {
  createRendererImageLoader,
  registerChatConnection,
} from "./chat/service";
import { showNotification } from "./notification";
import { ERRORS } from "./errors";

const noop = (): void => undefined;

// Eagerly load the iframe host chunk and the worker constructor so they're
// ready by the time we need them. The wasm core lives inside the worker. The host
// shell only owns the postMessage bridge, keeping smoldot's CPU off the
// main thread (no more `[Violation] 'message' handler took 150ms+`).
const chunkLoadStart = performance.now();
const runtimeChunkPromise = Promise.all([
  import("@parity/truapi-host/web"),
  import("@parity/truapi-host/worker-runtime?worker"),
]).then(([web, workerMod]) => {
  m.measure(S.BRIDGE_CHUNK_LOAD, performance.now() - chunkLoadStart);
  return {
    createWebWorkerPairingHostRuntime: web.createWebWorkerPairingHostRuntime,
    createWebWorkerSigningHostRuntime: web.createWebWorkerSigningHostRuntime,
    createIframeHost: web.createIframeHost,
    HostWorker: workerMod.default,
  };
});
void runtimeChunkPromise.catch(() => {
  /* fire-and-forget */
});

const app = document.getElementById("app") ?? document.body;

interface ActiveHost {
  core: CoreProvider;
  generation: number;
  iframe: HTMLIFrameElement;
  requestLogin: (reason?: string) => Promise<LoginResponse>;
  cancelLogin: () => void;
  disconnect: () => Promise<void>;
  dispose: () => void;
}

interface CoreHost {
  core: CoreProvider;
  requestLogin: (reason?: string) => Promise<LoginResponse>;
  cancelLogin: () => void;
  disconnect: () => Promise<void>;
  dispose: () => void;
}

type CoreProviderBase = Provider &
  Pick<
    TrUApiProductProvider,
    | "disconnectSession"
    | "getPermissionAuthorizationStatus"
    | "getPermissionAuthorizationStatuses"
    | "setPermissionAuthorizationStatus"
  >;
type CoreProvider = CoreProviderBase & PairingHostAdmin;
type PairingRuntimeControls = Partial<PairingHostAdmin> & {
  dispose(): void;
};
type CurrentProduct =
  | {
      mode: "iframe";
      label: string;
      url: string;
      productId?: string;
    }
  | {
      mode: "subdomain";
      label: string;
      cid: string;
      executableManifest: string | null;
    };

const LANDING_AUTH_LABEL = "dotli";
const LANDING_AUTH_DISPLAY_LABEL = "Polkadot Web";

let currentHost: ActiveHost | null = null;
let landingAuthHostPromise: Promise<CoreHost> | null = null;
let landingAuthGeneration = 0;
let currentPanelDispose: (() => void) | null = null;
let currentProduct: CurrentProduct | null = null;
let renderGeneration = 0;
const liveCoreProviders = new Set<CoreProvider>();
let unsubscribeSessionStoreChanges: (() => void) | null = null;
let blockingModalCoordinator: BlockingModalCoordinator | null = null;
const mediatedInputPermissionLimiter = createSubmitRateLimiter();
const mediatedInputHost = new MediatedInputHost({
  authorize: async (label, signal) => {
    const coordinator = blockingModalCoordinator;
    if (coordinator === null) {
      throw new Error("blocking modal coordinator is unavailable");
    }
    const scope = coordinator.createScope();
    const abort = (): void => {
      scope.dispose("mediated input cancelled");
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const decision = await decidePromptPermission(
        label,
        "Camera",
        {
          kind: "Device",
          limiter: mediatedInputPermissionLimiter,
          gatedByIframe: false,
        },
        scope,
      );
      return decision !== "Deny";
    } finally {
      signal.removeEventListener("abort", abort);
      scope.dispose();
    }
  },
  scan: (label, request, signal) => scanCameraUr(label, request, signal),
  send: (owner, handle, status, bytes) => {
    const product = currentProduct;
    const source = currentHost?.iframe.contentWindow;
    if (
      product?.mode !== "subdomain" ||
      source === null ||
      source === undefined ||
      owner !== source
    ) {
      return;
    }
    if (bytes === undefined) {
      source.postMessage(
        {
          type: "dotli:polkavm-mediated-input-result",
          handle,
          status,
        },
        sandboxOriginForLabel(product.label),
      );
      return;
    }
    const result = new Uint8Array(bytes);
    source.postMessage(
      {
        type: "dotli:polkavm-mediated-input-result",
        handle,
        status,
        bytes: result,
      },
      sandboxOriginForLabel(product.label),
      [result.buffer],
    );
  },
  isCancellation: (error) =>
    error instanceof CameraInputCancelledError ||
    (error instanceof DOMException && error.name === "AbortError"),
  isPermissionDenied: (error) => error instanceof CameraInputPermissionError,
});

interface LiveLocalWallet {
  runtime: WorkerSigningHostRuntime;
  binding: LocalWalletIdentityBinding;
  identity: LocalIdentity;
  nativeSessionUiInfo?: { publicKey?: string; fullUsername?: string };
}

const localRuntimeDisposers = new Set<() => void>();

function disposeWalletRuntimes(): void {
  disposeLandingAuthHost();
  for (const provider of [...liveCoreProviders]) {
    provider.dispose();
  }
  // Include workers still booting, before they have a tracked product provider.
  for (const dispose of [...localRuntimeDisposers]) {
    dispose();
  }
}
const liveLocalWallets = new Map<WorkerSigningHostRuntime, LiveLocalWallet>();
const providerWallets = new WeakMap<CoreProvider, LiveLocalWallet>();
let localIdentityUpdateQueue: Promise<unknown> = Promise.resolve();
let localIdentityOperationPending = false;

// Boot restoration and explicit updates share a queue: a provider created while
// a claim is pending cannot install an older cache after the claim completes.
function withLocalIdentityUpdate<T>(operation: () => Promise<T>): Promise<T> {
  const result = localIdentityUpdateQueue.then(operation);
  localIdentityUpdateQueue = result.catch(noop);
  return result;
}

async function activeLocalWallet(): Promise<LiveLocalWallet> {
  await initializeLocalWalletState();
  if (!isExperimentalWalletActive()) {
    throw new Error(
      "Enable the debug test wallet before checking its username.",
    );
  }
  const host = await getLandingAuthHost();
  const wallet = providerWallets.get(host.core);
  if (wallet === undefined) {
    throw new Error(
      "The current test wallet is not ready. Try again after it connects.",
    );
  }
  if (!isCurrentLocalWallet(wallet.binding)) {
    disposeWalletRuntimes();
    throw new Error(
      "The test wallet or network changed. Reopen the Wallet tab.",
    );
  }
  return wallet;
}

async function updateLocalIdentity(
  baseUsername?: string,
  onProgress?: (progress: LocalIdentityProgress) => void,
): Promise<LocalIdentity> {
  if (localIdentityOperationPending) {
    throw new Error("A username operation is already pending.");
  }
  localIdentityOperationPending = true;
  try {
    const wallet = await activeLocalWallet();
    return await withLocalIdentityUpdate(async () => {
      if (
        !isCurrentLocalWallet(wallet.binding) ||
        !liveLocalWallets.has(wallet.runtime)
      ) {
        throw new Error(
          "Test wallet changed. Retry with the current identity.",
        );
      }
      const identity =
        baseUsername === undefined
          ? await wallet.runtime.refreshLocalIdentity()
          : await wallet.runtime.registerLocalLiteUsername(
              baseUsername,
              new URL(
                getActiveServicesConfig().identityBackendBaseUrl,
                window.location.origin,
              ).href,
              onProgress === undefined
                ? undefined
                : (progress) => {
                    if (
                      isCurrentLocalWallet(wallet.binding) &&
                      liveLocalWallets.has(wallet.runtime)
                    ) {
                      onProgress(progress);
                    }
                  },
            );
      if (
        identity.identityAccountId !== wallet.binding.identityAccountId ||
        (baseUsername !== undefined &&
          (identity.liteUsername?.trim() ?? "") === "")
      ) {
        throw new Error(
          "Native username confirmation did not match the active identity.",
        );
      }
      if (
        !isCurrentLocalWallet(wallet.binding) ||
        !liveLocalWallets.has(wallet.runtime)
      ) {
        throw new Error("Test wallet changed while confirming its username.");
      }
      wallet.identity = identity;
      if (baseUsername !== undefined && identity.liteUsername !== undefined) {
        showNotification({
          text: `${identity.liteUsername} is confirmed on-chain and ready to use.`,
          label: "Username claimed",
          browserNotification: false,
        });
      }
      // Persist only the SDK's ownership-confirmed result. An absent username is
      // a verified chain absence, not a failed RPC or HTTP acceptance response.
      let persistenceError: unknown;
      try {
        await writeVerifiedLocalIdentity(wallet.binding, identity);
      } catch (error) {
        persistenceError = error;
      }
      const updates = await Promise.allSettled(
        [...liveLocalWallets.values()]
          .filter(
            (entry) =>
              entry !== wallet &&
              isCurrentLocalWallet(entry.binding) &&
              entry.binding.identityAccountId === identity.identityAccountId,
          )
          .map(async (entry) => {
            // Reactivating a live runtime would reset its session/grants. Refresh
            // updates SessionInfo in place so current apps immediately get_user_id.
            let refreshed: LocalIdentity;
            try {
              refreshed = await entry.runtime.refreshLocalIdentity();
            } catch (error) {
              // Product replacement retires its native session, not the claim.
              if (!liveLocalWallets.has(entry.runtime)) {
                return;
              }
              throw error;
            }
            if (!liveLocalWallets.has(entry.runtime)) {
              return;
            }
            if (
              !isCurrentLocalWallet(entry.binding) ||
              refreshed.identityAccountId !== identity.identityAccountId ||
              refreshed.liteUsername !== identity.liteUsername
            ) {
              throw new Error(
                "A running app has not confirmed the same username yet.",
              );
            }
            entry.identity = refreshed;
          }),
      );
      if (!isCurrentLocalWallet(wallet.binding)) {
        throw new Error(
          "Test wallet changed while synchronizing its username.",
        );
      }
      if (updates.some((result) => result.status === "rejected")) {
        showNotification({
          text: "The wallet username is confirmed, but a running product could not update its account. Reload that product to reconnect.",
          label: "Product account update failed",
          browserNotification: false,
        });
      }
      if (persistenceError !== undefined) {
        throw new Error(
          `Chain confirmed ${identity.liteUsername ?? "no registered Lite username"}, but saving shared metadata failed. Use Check username to retry; do not submit another claim.`,
        );
      }
      return identity;
    });
  } finally {
    localIdentityOperationPending = false;
  }
}
const INSPECTOR_REQUEST_PREFIX = "dotli:host-inspector:";
let inspectorRequestSequence = 0;
let inspectorResourcePending = false;

function inspectorRequestId(message: Uint8Array): string | null {
  try {
    // Read only the leading SCALE string; decoding the whole wire message
    // would copy every guest payload solely to check this reserved namespace.
    const id = scale.str.dec(message);
    return id.startsWith(INSPECTOR_REQUEST_PREFIX) ? id : null;
  } catch {
    return null;
  }
}

function assertInspectorWallet(wallet: LiveLocalWallet): void {
  if (
    !DEBUG ||
    !isExperimentalWalletActive() ||
    !isCurrentLocalWallet(wallet.binding) ||
    liveLocalWallets.get(wallet.runtime) !== wallet ||
    wallet.identity.identityAccountId !== wallet.binding.identityAccountId
  ) {
    throw new Error("The test identity changed. Reopen the Wallet tab.");
  }
}

function inspectorProductContext(): InspectorProductContext | null {
  const product = currentProduct;
  const host = currentHost;
  if (product === null) {
    return null;
  }
  const wallet = host === null ? undefined : providerWallets.get(host.core);
  if (host?.generation !== renderGeneration || wallet === undefined) {
    throw new Error("The current product's test wallet is not ready.");
  }
  assertInspectorWallet(wallet);
  const generation = renderGeneration;
  return {
    product,
    host,
    wallet,
    id:
      product.mode === "iframe"
        ? (product.productId ?? labelToProductId(product.label))
        : labelToProductId(product.label),
    assertCurrent(): void {
      assertInspectorWallet(wallet);
      if (
        currentProduct !== product ||
        currentHost !== host ||
        generation !== renderGeneration
      ) {
        throw new Error(
          "The product changed during the Wallet tab operation. An allocation already submitted may have completed; check its outcome before making another request.",
        );
      }
    },
  };
}

interface InspectorProductContext {
  product: CurrentProduct;
  host: ActiveHost;
  wallet: LiveLocalWallet;
  id: string;
  assertCurrent(): void;
}

// The generated transport starts at p:1 and auto-answers inbound handshakes.
// Give it only its own namespaced responses, never the guest's handshake or
// traffic. Its dispose() detaches listeners; this adapter never owns the core.
async function withInspectorClient<T>(
  context: InspectorProductContext,
  operation: (client: TrUApiClient) => PromiseLike<T>,
): Promise<T> {
  context.assertCurrent();
  const prefix = `${INSPECTOR_REQUEST_PREFIX}${String(++inspectorRequestSequence)}:`;
  const transport = createTransport({
    postMessage(message) {
      context.assertCurrent();
      const decoded = decodeWireMessage(message);
      if (decoded.isErr()) {
        throw decoded.error;
      }
      const frame = encodeWireMessage({
        ...decoded.value,
        requestId: prefix + decoded.value.requestId,
      });
      if (frame.isErr()) {
        throw frame.error;
      }
      context.host.core.postMessage(frame.value);
    },
    subscribe(callback) {
      return context.host.core.subscribe((message) => {
        if (inspectorRequestId(message)?.startsWith(prefix) !== true) {
          return;
        }
        const decoded = decodeWireMessage(message);
        if (decoded.isErr()) {
          return;
        }
        const frame = encodeWireMessage({
          ...decoded.value,
          requestId: decoded.value.requestId.slice(prefix.length),
        });
        if (frame.isOk()) {
          callback(frame.value);
        }
      });
    },
    subscribeClose(callback) {
      return context.host.core.subscribeClose?.(callback) ?? noop;
    },
    dispose: noop,
  });
  try {
    // createClient merely binds methods; do not invoke system.handshake().
    const result = await operation(createClient(transport));
    context.assertCurrent();
    return result;
  } finally {
    transport.dispose();
  }
}

// SCALE encoders may coerce invalid numbers or ignore extra fields. Require
// the decoded canonical value to match the input, not just encode successfully.
function matchesResourceValue(input: unknown, canonical: unknown): boolean {
  if (input === canonical) {
    return true;
  }
  if (
    typeof input !== "object" ||
    input === null ||
    typeof canonical !== "object" ||
    canonical === null
  ) {
    return false;
  }
  const actual = input as Record<string, unknown>;
  const expected = canonical as Record<string, unknown>;
  return (
    Object.keys(actual).every(
      (key) => actual[key] === undefined || Object.hasOwn(expected, key),
    ) &&
    Object.keys(expected).every((key) =>
      matchesResourceValue(actual[key], expected[key]),
    )
  );
}

function describeResource(resource: unknown): {
  id: string;
  label: string;
  request: AllocatableResource;
} | null {
  try {
    const encoded = AllocatableResource.enc(resource as AllocatableResource);
    const request = AllocatableResource.dec(encoded);
    if (
      request.tag === "AutoSigning" ||
      !matchesResourceValue(resource, request)
    ) {
      return null;
    }
    const selector = request.value as unknown;
    const suffix =
      typeof selector === "object" &&
      selector !== null &&
      "tag" in selector &&
      "value" in selector &&
      (selector.tag === "Index" || selector.tag === "Raw")
        ? ` (${selector.tag} ${String(selector.value)})`
        : "";
    return {
      id: Array.from(encoded, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
      label: request.tag.replace(/([a-z])([A-Z])/g, "$1 $2") + suffix,
      request,
    };
  } catch {
    return null;
  }
}

async function getInspectorProduct(): Promise<InspectorProduct | null> {
  const context = inspectorProductContext();
  if (context === null) {
    return null;
  }
  const statuses = await context.host.core.getPermissionAuthorizationStatuses(
    ALL_PERMISSIONS.map(({ name }) => authorizationRequest(name)),
  );
  context.assertCurrent();
  if (statuses.length !== ALL_PERMISSIONS.length) {
    throw new Error("Native permission status response was incomplete.");
  }
  let accountPublicKey: string | undefined;
  let accountError: string | undefined;
  try {
    const result = await withInspectorClient(context, (client) =>
      client.account.getAccount({
        productAccountId: {
          dotNsIdentifier: context.id,
          derivationIndex: { tag: "Index", value: 0 },
        },
      }),
    );
    if (result.isErr()) {
      accountError = "Native host did not disclose this product account.";
    } else {
      accountPublicKey = result.value.account.publicKey;
    }
  } catch (error) {
    context.assertCurrent();
    accountError =
      error instanceof Error ? error.message : "Product account lookup failed.";
  }
  context.assertCurrent();
  const defaults: AllocatableResource[] = [
    { tag: "StatementStoreAllowance" },
    { tag: "BulletinAllowance" },
    { tag: "SmartContractAllowance", value: { tag: "Index", value: 0 } },
  ];
  return {
    id: context.id,
    name: context.product.label,
    origin:
      context.product.mode === "iframe"
        ? new URL(context.product.url, window.location.href).origin
        : sandboxOriginForLabel(context.product.label),
    accountPublicKey,
    accountError,
    derivation: `ProductAccountId: ${context.id}; derivationIndex: Index 0 (native product-scoped account, not a BIP-44 path).`,
    permissions: ALL_PERMISSIONS.map(({ name, label }, index) => ({
      id: name,
      label,
      status: fromAuthorizationStatus(statuses[index]),
    })),
    resources: defaults.flatMap((resource) => {
      const description = describeResource(resource);
      return description === null ? [] : [description];
    }),
  };
}

async function requestInspectorResource(
  productId: string,
  resource: unknown,
): Promise<"Allocated" | "Rejected" | "NotAvailable"> {
  if (inspectorResourcePending) {
    throw new Error("A resource request is already pending.");
  }
  const context = inspectorProductContext();
  if (context?.id !== productId) {
    throw new Error(
      "Select the current product before requesting an allowance.",
    );
  }
  const description = describeResource(resource);
  if (description === null) {
    throw new Error(
      "Unsupported allowance request. Auto-signing is a permission, not an allowance.",
    );
  }
  inspectorResourcePending = true;
  try {
    // This is the same native product provider and its host confirmation flow.
    // An outcome is not a balance: the API exposes no remaining-quota counter.
    const result = await withInspectorClient(context, (client) =>
      client.resourceAllocation.request({ resources: [description.request] }),
    );
    if (result.isErr()) {
      throw new Error("Native resource allocation failed.", {
        cause: result.error,
      });
    }
    if (result.value.outcomes.length !== 1) {
      throw new Error(
        "Native allocation returned no unique outcome. Do not retry blindly.",
      );
    }
    return result.value.outcomes[0];
  } finally {
    inspectorResourcePending = false;
  }
}

// Mode switches reload deliberately: no signing worker from the previous
// identity may survive switching back to mobile pairing.
export const experimentalWalletControls = {
  isActive: isExperimentalWalletActive,
  networkLabel(): string {
    return getActiveServicesConfig().label;
  },
  getCachedIdentity() {
    const display = readLocalWalletDisplay();
    return display === undefined
      ? undefined
      : { ...display, network: getActiveServicesConfig().label };
  },
  async getIdentity(): Promise<
    LocalIdentity & {
      network: string;
      publicKey?: string;
      fullUsername?: string;
    }
  > {
    const wallet = await activeLocalWallet();
    assertInspectorWallet(wallet);
    return {
      ...wallet.identity,
      ...wallet.nativeSessionUiInfo,
      network: getActiveServicesConfig().label,
    };
  },
  getProduct: getInspectorProduct,
  describeResource,
  requestResource: requestInspectorResource,
  refreshUsername(): Promise<LocalIdentity> {
    return updateLocalIdentity();
  },
  claimLiteUsername(
    baseUsername: string,
    onProgress?: (progress: LocalIdentityProgress) => void,
  ): Promise<LocalIdentity> {
    const username = baseUsername.trim();
    if (username === "" || username.includes(".")) {
      return Promise.reject(
        new Error("Enter a base username only, without a network suffix."),
      );
    }
    return updateLocalIdentity(username, onProgress);
  },
  async activate(): Promise<void> {
    if (!DEBUG) {
      throw new Error("Experimental wallets require a debug build");
    }
    const { secret } = await createLocalWalletSecret();
    secret.fill(0);
    disposeWalletRuntimes();
    await setLocalWalletEnabled(true);
    window.location.reload();
  },
  async disconnect(): Promise<void> {
    if (!DEBUG) {
      return Promise.reject(
        new Error("Experimental wallets require a debug build"),
      );
    }
    if (isExperimentalWalletActive()) {
      disposeWalletRuntimes();
    }
    await setLocalWalletEnabled(false);
    window.location.reload();
  },
  async exportMnemonic(): Promise<string> {
    if (!DEBUG) {
      throw new Error("Experimental wallets require a debug build");
    }
    return exportLocalWalletMnemonic();
  },
  async importMnemonic(mnemonic: string): Promise<void> {
    if (!DEBUG) {
      throw new Error("Experimental wallets require a debug build");
    }
    await importLocalWalletMnemonic(mnemonic, () => {
      disposeWalletRuntimes();
    });
    await setLocalWalletEnabled(true);
    window.location.reload();
  },
  async deleteWallet(): Promise<void> {
    if (!DEBUG) {
      throw new Error("Experimental wallets require a debug build");
    }
    if (isExperimentalWalletActive()) {
      disposeWalletRuntimes();
    }
    await deleteLocalWalletSecret();
    await setLocalWalletEnabled(false);
    window.location.reload();
  },
};

function ensureStoredSessionForwarder(): void {
  if (unsubscribeSessionStoreChanges !== null) {
    return;
  }
  const unsubscribeSession = onStoredSessionChanged(() => {
    notifyLiveCoreProvidersSessionStoreChanged();
  });
  const unsubscribeIdentity = onVerifiedLocalIdentityChanged(() => {
    void withLocalIdentityUpdate(async () => {
      await Promise.all(
        [...liveLocalWallets.values()].map(async (entry) => {
          if (!isCurrentLocalWallet(entry.binding)) {
            return;
          }
          const cached = await readVerifiedLocalIdentity(entry.binding);
          if (
            cached === undefined ||
            cached.liteUsername === entry.identity.liteUsername ||
            !isCurrentLocalWallet(entry.binding) ||
            !liveLocalWallets.has(entry.runtime)
          ) {
            return;
          }
          // Other trusted host tabs learn of the shared record, then update their
          // own native sessions by checking the chain, without resetting grants.
          const identity = await entry.runtime.refreshLocalIdentity();
          if (
            isCurrentLocalWallet(entry.binding) &&
            liveLocalWallets.has(entry.runtime)
          ) {
            entry.identity = identity;
          }
        }),
      );
    }).catch((error: unknown) => {
      log.warn("[dot.li] shared test-wallet username refresh failed:", error);
      showNotification({
        text: "A shared test-wallet username changed, but this app could not refresh it. Use Wallet tab → Check username.",
        label: "Test wallet",
        browserNotification: false,
      });
    });
  });
  unsubscribeSessionStoreChanges = () => {
    unsubscribeSession();
    unsubscribeIdentity();
  };
}

function trackCoreProvider(
  provider: CoreProviderBase,
  pairing: PairingRuntimeControls,
  disposeModalScope: () => void,
): CoreProvider {
  let disposed = false;
  const tracked: CoreProvider = {
    postMessage(message: Uint8Array): void {
      provider.postMessage(message);
    },
    subscribe(callback) {
      return provider.subscribe(callback);
    },
    subscribeClose(callback) {
      return provider.subscribeClose?.(callback) ?? noop;
    },
    async disconnectSession() {
      await provider.disconnectSession();
    },
    cancelPairing() {
      pairing.cancelPairing?.();
    },
    notifySessionStoreChanged() {
      pairing.notifySessionStoreChanged?.();
    },
    getPermissionAuthorizationStatus(request) {
      return provider.getPermissionAuthorizationStatus(request);
    },
    getPermissionAuthorizationStatuses(requests) {
      return provider.getPermissionAuthorizationStatuses(requests);
    },
    setPermissionAuthorizationStatus(request, status) {
      return provider.setPermissionAuthorizationStatus(request, status);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      liveCoreProviders.delete(tracked);
      if (
        liveCoreProviders.size === 0 &&
        unsubscribeSessionStoreChanges !== null
      ) {
        unsubscribeSessionStoreChanges();
        unsubscribeSessionStoreChanges = null;
      }
      disposeModalScope();
      provider.dispose();
      pairing.dispose();
    },
  };
  liveCoreProviders.add(tracked);
  ensureStoredSessionForwarder();
  queueMicrotask(() => {
    if (!disposed) {
      tracked.notifySessionStoreChanged();
    }
  });
  return tracked;
}

function notifyLiveCoreProvidersSessionStoreChanged(): void {
  for (const provider of [...liveCoreProviders]) {
    provider.notifySessionStoreChanged();
  }
}

function rerenderProduct(product: CurrentProduct): void {
  const expectedGeneration = renderGeneration + 1;
  const render =
    product.mode === "iframe"
      ? renderIframe(product.url, product.label, {
          productId: product.productId,
        })
      : renderAppSubdomain(
          product.cid,
          product.label,
          product.executableManifest,
        );
  void render.catch((error: unknown) => {
    // A newer render superseded this one, so its result owns the UI now.
    if (renderGeneration !== expectedGeneration) {
      return;
    }
    log.error("[dot.li] Product iframe reload failed:", error);
    showNotification({
      label: "dot.li",
      text: "The app could not be reloaded.",
      browserNotification: false,
      dismissMs: 0,
      action: {
        label: "Reload",
        onClick: () => {
          window.location.reload();
        },
      },
    });
  });
}

// Listen for device permission grants. Reload the iframe so the updated
// `allow` attribute takes effect. Keep the current iframe visible and surface
// a retry if replacement host startup fails.
window.addEventListener("dotli:device-permission-changed", () => {
  const product = currentProduct;
  if (product !== null) {
    rerenderProduct(product);
  }
});

let motionRelayCleanup: (() => void) | null = null;
let motionPromptSource: Window | null = null;
let motionPromptDismiss: (() => void) | null = null;

function stopMotionRelay(): void {
  motionRelayCleanup?.();
  motionRelayCleanup = null;
  motionPromptDismiss?.();
  motionPromptDismiss = null;
  motionPromptSource = null;
}

function sendMotionStatus(
  source: Window,
  origin: string,
  availability: 0 | 1 | 2,
): void {
  source.postMessage(
    { type: "dotli:polkavm-motion-status", availability },
    origin,
  );
}

function offerTopLevelMotionPermission(
  source: Window,
  origin: string,
  label: string,
): void {
  if (motionRelayCleanup !== null) {
    sendMotionStatus(source, origin, 1);
    return;
  }
  if (motionPromptSource === source) {
    return;
  }
  motionPromptSource = source;
  let permissionPending = false;
  const dismissPrompt = showNotification({
    label: withActiveTld(label),
    text: "Enable motion to tilt this application with your device.",
    dismissMs: 0,
    browserNotification: false,
    action: {
      label: "Enable motion",
      onClick: () => {
        if (motionRelayCleanup !== null) {
          sendMotionStatus(source, origin, 1);
          return;
        }
        if (permissionPending) {
          return;
        }
        permissionPending = true;
        const constructor =
          typeof DeviceMotionEvent === "undefined"
            ? null
            : (DeviceMotionEvent as typeof DeviceMotionEvent & {
                requestPermission?: () => Promise<"granted" | "denied">;
              });
        let request: Promise<"granted" | "denied" | "unavailable">;
        try {
          request =
            constructor === null
              ? Promise.resolve("unavailable")
              : typeof constructor.requestPermission === "function"
                ? constructor.requestPermission()
                : Promise.resolve("granted");
        } catch {
          permissionPending = false;
          sendMotionStatus(source, origin, 2);
          return;
        }
        void request
          .then((permission) => {
            if (
              currentHost?.iframe.contentWindow !== source ||
              currentProduct?.mode !== "subdomain"
            ) {
              return;
            }
            if (permission === "unavailable") {
              sendMotionStatus(source, origin, 0);
              return;
            }
            if (permission !== "granted") {
              sendMotionStatus(source, origin, 2);
              return;
            }
            const onMotion = (event: DeviceMotionEvent): void => {
              const acceleration = event.accelerationIncludingGravity;
              const rotation = event.rotationRate;
              source.postMessage(
                {
                  type: "dotli:polkavm-motion-sample",
                  timestampMs: performance.now(),
                  acceleration:
                    acceleration === null
                      ? null
                      : {
                          x: acceleration.x,
                          y: acceleration.y,
                          z: acceleration.z,
                        },
                  rotation:
                    rotation === null
                      ? null
                      : {
                          alpha: rotation.alpha,
                          beta: rotation.beta,
                          gamma: rotation.gamma,
                        },
                },
                origin,
              );
            };
            window.addEventListener("devicemotion", onMotion);
            motionRelayCleanup = () => {
              window.removeEventListener("devicemotion", onMotion);
            };
            dismissPrompt();
            motionPromptSource = null;
            sendMotionStatus(source, origin, 1);
          })
          .catch(() => {
            sendMotionStatus(source, origin, 2);
          })
          .finally(() => {
            permissionPending = false;
          });
      },
    },
    onDismiss: () => {
      if (motionPromptDismiss === dismissPrompt) {
        motionPromptDismiss = null;
      }
      if (motionPromptSource === source) {
        motionPromptSource = null;
      }
    },
  });
  motionPromptDismiss = dismissPrompt;
}

// A sandbox reload asks the host to rebuild the iframe from tracked product
// state. A schema mismatch is different: re-rendering would resend the same
// stale contract, so forward a host-update event to the PWA coordinator.
// Both messages are origin-gated to the product currently rendered. Recovery
// is rate-limited so a reload-looping product cannot pin the host in endless
// re-renders; update activation has its own idempotence guard in `pwa.ts`.
const RECOVER_MIN_INTERVAL_MS = 5_000;
let lastRecoverAt = 0;
window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as Record<string, unknown> | null;
  const type = data?.type;
  if (
    type !== "dotli:sandbox-recover" &&
    type !== "dotli:host-update-required" &&
    type !== "dotli:polkavm-motion-request" &&
    type !== "dotli:polkavm-mediated-input-request" &&
    type !== "dotli:polkavm-mediated-input-cancel"
  ) {
    return;
  }
  const product = currentProduct;
  const source = currentHost?.iframe.contentWindow;
  if (
    product?.mode !== "subdomain" ||
    event.origin !== sandboxOriginForLabel(product.label) ||
    source === null ||
    source === undefined ||
    event.source !== source
  ) {
    return;
  }
  if (type === "dotli:polkavm-motion-request") {
    offerTopLevelMotionPermission(source, event.origin, product.label);
    return;
  }
  if (type === "dotli:polkavm-mediated-input-request") {
    const request = validatedMediatedInputRequest(data);
    if (request !== null) {
      mediatedInputHost.request(source, product.label, request);
    }
    return;
  }
  if (type === "dotli:polkavm-mediated-input-cancel") {
    if (
      data !== null &&
      Object.keys(data).every((key) => key === "type" || key === "handle") &&
      Number.isInteger(data.handle) &&
      Number(data.handle) >= 1 &&
      Number(data.handle) <= 0xffffffff
    ) {
      mediatedInputHost.cancel(source, Number(data.handle));
    }
    return;
  }
  if (type === "dotli:host-update-required") {
    window.dispatchEvent(new Event("dotli:host-update-required"));
    return;
  }
  const now = Date.now();
  if (now - lastRecoverAt < RECOVER_MIN_INTERVAL_MS) {
    return;
  }
  lastRecoverAt = now;
  rerenderProduct(product);
});

type PolkaVmPlatformCommand =
  | Readonly<{ type: "copy-text"; text: string }>
  | Readonly<{
      type: "copy-image";
      width: number;
      height: number;
      rgba: Uint8Array;
    }>
  | Readonly<{ type: "open-url"; url: string }>;

// Cold guest work can exceed one second. Browser transient activation must
// still be live when the command arrives; this bound never extends it.
const POLKAVM_PLATFORM_ACTIVATION_MS = 5_000;
const MAX_POLKAVM_COPY_TEXT_BYTES = 64 * 1024;
const MAX_POLKAVM_COPY_IMAGE_PIXELS = 1024 * 1024;
const MAX_POLKAVM_COPY_IMAGE_DIMENSION = 2048;
const MAX_POLKAVM_OPEN_URL_BYTES = 8 * 1024;
const polkavmPlatformEncoder = new TextEncoder();
let polkavmPlatformActivation: Readonly<{
  source: MessageEventSource;
  origin: string;
  expiresAt: number;
}> | null = null;

function validatedPolkaVmPlatformCommand(
  value: unknown,
): PolkaVmPlatformCommand | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const command = value as Record<string, unknown>;
  if (
    command.type === "copy-text" &&
    Object.keys(command).every((key) => key === "type" || key === "text") &&
    typeof command.text === "string" &&
    polkavmPlatformEncoder.encode(command.text).byteLength <=
      MAX_POLKAVM_COPY_TEXT_BYTES
  ) {
    return { type: "copy-text", text: command.text };
  }
  if (
    command.type === "copy-image" &&
    Object.keys(command).every((key) =>
      ["type", "width", "height", "rgba"].includes(key),
    ) &&
    Number.isInteger(command.width) &&
    Number.isInteger(command.height) &&
    Number(command.width) > 0 &&
    Number(command.height) > 0 &&
    Number(command.width) <= MAX_POLKAVM_COPY_IMAGE_DIMENSION &&
    Number(command.height) <= MAX_POLKAVM_COPY_IMAGE_DIMENSION &&
    Number(command.width) * Number(command.height) <=
      MAX_POLKAVM_COPY_IMAGE_PIXELS &&
    command.rgba instanceof Uint8Array &&
    command.rgba.byteLength ===
      Number(command.width) * Number(command.height) * 4
  ) {
    return {
      type: "copy-image",
      width: Number(command.width),
      height: Number(command.height),
      rgba: command.rgba,
    };
  }
  if (
    command.type === "open-url" &&
    Object.keys(command).every((key) => key === "type" || key === "url") &&
    typeof command.url === "string" &&
    command.url !== "" &&
    polkavmPlatformEncoder.encode(command.url).byteLength <=
      MAX_POLKAVM_OPEN_URL_BYTES
  ) {
    return {
      type: "open-url",
      url: command.url,
    };
  }
  return null;
}

function clipboardImagePng(
  command: Extract<PolkaVmPlatformCommand, { type: "copy-image" }>,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = command.width;
  canvas.height = command.height;
  const context = canvas.getContext("2d");
  if (context === null) {
    return Promise.reject(new Error("2D canvas is unavailable"));
  }
  context.putImageData(
    new ImageData(
      new Uint8ClampedArray(command.rgba),
      command.width,
      command.height,
    ),
    0,
    0,
  );
  const { promise, resolve, reject } = (
    Promise as PromiseConstructor & {
      withResolvers<T>(): {
        promise: Promise<T>;
        resolve: (value: T | PromiseLike<T>) => void;
        reject: (reason?: unknown) => void;
      };
    }
  ).withResolvers<Blob>();
  canvas.toBlob((blob) => {
    if (blob === null) {
      reject(new Error("PNG encoding failed"));
    } else {
      resolve(blob);
    }
  }, "image/png");
  return promise;
}

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as { type?: unknown; command?: unknown } | null;
  if (
    data?.type !== "dotli:polkavm-user-activation" &&
    data?.type !== "dotli:polkavm-ui-command"
  ) {
    return;
  }
  const product = currentProduct;
  const source = currentHost?.iframe.contentWindow;
  if (
    product?.mode !== "subdomain" ||
    event.origin !== sandboxOriginForLabel(product.label) ||
    source === null ||
    event.source !== source
  ) {
    return;
  }
  if (data.type === "dotli:polkavm-user-activation") {
    if (navigator.userActivation.isActive) {
      polkavmPlatformActivation = {
        source,
        origin: event.origin,
        expiresAt: performance.now() + POLKAVM_PLATFORM_ACTIVATION_MS,
      };
    }
    return;
  }
  const activation = polkavmPlatformActivation;
  polkavmPlatformActivation = null;
  if (activation === null) {
    return;
  }
  if (
    activation.source !== event.source ||
    activation.origin !== event.origin ||
    activation.expiresAt < performance.now() ||
    !navigator.userActivation.isActive
  ) {
    return;
  }
  const command = validatedPolkaVmPlatformCommand(data.command);
  if (command === null) {
    return;
  }
  if (command.type === "copy-text") {
    void navigator.clipboard.writeText(command.text).catch((error: unknown) => {
      log.warn("[dot.li] PolkaVM clipboard request was declined:", error);
    });
    return;
  }
  if (command.type === "copy-image") {
    try {
      const item = new ClipboardItem({
        "image/png": clipboardImagePng(command),
      });
      void navigator.clipboard.write([item]).catch((error: unknown) => {
        log.warn(
          "[dot.li] PolkaVM image clipboard request was declined:",
          error,
        );
      });
    } catch (error) {
      log.warn("[dot.li] PolkaVM image clipboard is unavailable:", error);
    }
    return;
  }
  let destination: URL;
  try {
    destination = new URL(command.url);
  } catch {
    return;
  }
  if (destination.protocol !== "https:") {
    return;
  }
  window.open(destination.href, "_blank", "noopener,noreferrer");
});

let bridgeEventListenersInitialized = false;

export function initBridgeEventListeners(
  modalCoordinator: BlockingModalCoordinator,
): void {
  if (bridgeEventListenersInitialized) {
    return;
  }
  blockingModalCoordinator = modalCoordinator;
  bridgeEventListenersInitialized = true;
  (
    window as typeof window & { __dotliTruapiBridgeReady?: boolean }
  ).__dotliTruapiBridgeReady = true;
  if (DEBUG) {
    window.addEventListener("storage", (event) => {
      if (
        event.key === LOCAL_WALLET_ENABLED_KEY ||
        event.key === LOCAL_WALLET_REVISION_KEY ||
        event.key === null
      ) {
        disposeWalletRuntimes();
        window.location.reload();
      }
    });
    // The host identity is available on the landing page and outlives every
    // product. Mobile keeps its existing lazy pairing lifecycle.
    const generation = landingAuthGeneration;
    void initializeLocalWalletState()
      .then(async () => {
        if (
          isExperimentalWalletActive() &&
          generation === landingAuthGeneration
        ) {
          await getLandingAuthHost();
        }
      })
      .catch((error: unknown) => {
        if (
          isExperimentalWalletActive() &&
          generation === landingAuthGeneration
        ) {
          dispatchAuthState({
            tag: "WalletUnavailable",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      });
  }
  window.addEventListener("dotli:truapi-disconnect-request", () => {
    if (isExperimentalWalletActive()) {
      void experimentalWalletControls.disconnect();
      return;
    }
    void disconnectTruapiHosts();
  });

  // User closed the pairing modal: cancel whichever core initiated it. A
  // product can request login directly, while the topbar uses the landing
  // auth host.
  window.addEventListener("dotli:truapi-cancel-login", () => {
    currentHost?.cancelLogin();
    void landingAuthHostPromise?.then(
      (host) => {
        host.cancelLogin();
      },
      () => {
        /* a failed pending host has no login to cancel */
      },
    );
  });

  window.addEventListener("dotli:truapi-login-request", (event: Event) => {
    const detail = (event as CustomEvent<{ reason?: string }>).detail;
    void (async () => {
      const host = await getLandingAuthHost();
      const result = await host.requestLogin(detail.reason);
      if (result === "Success" || result === "AlreadyConnected") {
        notifyLiveCoreProvidersSessionStoreChanged();
      }
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // A `LoginRequestError` came back over the wire, so the core already
      // rendered its own `LoginFailed` (or deliberately stayed silent, e.g.
      // a second login while one is pairing). Synthesize a state only for
      // failures the core never saw: host boot, encode, transport errors.
      if (!(error instanceof LoginRequestError)) {
        dispatchAuthState({
          tag: "LoginFailed",
          kind: "Other",
          reason: message,
        });
      }
    });
  });
}

async function disconnectTruapiHosts(): Promise<void> {
  const hosts = new Set<CoreHost | ActiveHost>();
  if (currentHost !== null) {
    hosts.add(currentHost);
  }
  if (landingAuthHostPromise !== null) {
    try {
      hosts.add(await landingAuthHostPromise);
    } catch (err) {
      log.warn("[dot.li] pending login host cleanup failed:", err);
    }
  }

  if (hosts.size === 0) {
    try {
      hosts.add(await getLandingAuthHost());
    } catch {
      // If the auth runtime cannot boot, keep the UI responsive even though
      // persisted core session state could not be cleared.
      dispatchAuthState({ tag: "Disconnected" });
      return;
    }
  }
  await Promise.allSettled([...hosts].map((host) => host.disconnect()));
}

/**
 * Capture the deep link path, meaning pathname, search and hash, to forward
 * into the iframe.
 */
function getDeepPath(): string {
  const { pathname, search, hash } = window.location;
  let p = pathname;
  const base = import.meta.env.BASE_URL;
  if (base !== "/" && p.startsWith(base)) {
    p = "/" + p.slice(base.length);
  }
  const isRoot = p === "" || p === "/";
  if (isRoot) {
    return search || hash ? search + hash : "";
  }
  return p + search + hash;
}

/** Pin the product iframe to the area the host chrome and the insets leave. */
function applyIframeStyling(
  iframe: HTMLIFrameElement,
  opts: { topbarOffset: boolean },
): void {
  const box = productIframeBox(opts);
  iframe.style.cssText = `position:fixed;top:${box.top};left:${box.left};width:${box.width};height:${box.height};border:none;margin:0;padding:0;`;
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";
}

function pipeProviders(
  product: Provider,
  core: Provider,
  args: { flowId: string; label: string; productId: string },
): () => void {
  let sawInbound = false;
  let sawOutbound = false;
  const unsubs = [
    product.subscribe((message) => {
      // This namespace belongs to host-only clients. Guests cannot inject a
      // matching request or receive an inspector response.
      if (inspectorRequestId(message) !== null) {
        return;
      }
      if (!sawInbound) {
        sawInbound = true;
        emitDotliDebugEvent({
          layer: "bridge",
          event: "first_inbound",
          flowId: args.flowId,
          timestamp: Date.now(),
          payload: { label: args.label, productId: args.productId },
        });
      }
      core.postMessage(message);
    }),
    core.subscribe((message) => {
      if (inspectorRequestId(message) !== null) {
        return;
      }
      if (!sawOutbound) {
        sawOutbound = true;
        emitDotliDebugEvent({
          layer: "bridge",
          event: "first_outbound",
          flowId: args.flowId,
          timestamp: Date.now(),
          payload: { label: args.label, productId: args.productId },
        });
        window.dispatchEvent(new Event("dotli:debug:bridge-ready"));
      }
      product.postMessage(message);
    }),
    product.subscribeClose?.(() => {
      core.dispose();
    }),
    core.subscribeClose?.(() => {
      product.dispose();
    }),
  ].filter((fn): fn is () => void => typeof fn === "function");

  return () => {
    for (const unsub of unsubs) {
      try {
        unsub();
        // eslint-disable-next-line no-restricted-syntax -- provider teardown is best-effort. Stale MessagePorts can already be closed while the next cleanup still must run.
      } catch {
        /* ignore teardown races */
      }
    }
  };
}

function emitWireFrameDebug(
  direction: "incoming" | "outgoing",
  productId: string,
  message: Uint8Array,
): void {
  if (!hasDotliDebugListeners()) {
    return;
  }
  try {
    const decoded = decodeWireMessage(message);
    if (decoded.isErr()) {
      return;
    }
    emitDotliDebugEvent({
      kind: "truapi",
      direction,
      productId,
      requestId: decoded.value.requestId,
      payload: describeWireFrame(decoded.value.payload),
    });
    // eslint-disable-next-line no-restricted-syntax -- this runs synchronously on the transport path and nanoevents does not isolate listener exceptions, so a debug listener must never be able to break message delivery.
  } catch {
    /* ignore, debug tap failures must not affect the transport */
  }
}

function wrapCoreProviderForDebug(
  provider: CoreProviderBase,
  productId: string,
): CoreProviderBase {
  const listeners = new Set<(message: Uint8Array) => void>();
  let disposed = false;
  const unsubscribeCore = provider.subscribe((message) => {
    if (disposed) {
      return;
    }
    emitWireFrameDebug("outgoing", productId, message);
    for (const listener of [...listeners]) {
      listener(message);
    }
  });

  return {
    postMessage(message: Uint8Array): void {
      if (disposed) {
        return;
      }
      emitWireFrameDebug("incoming", productId, message);
      provider.postMessage(message);
    },
    subscribe(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    subscribeClose(callback) {
      return provider.subscribeClose?.(callback) ?? noop;
    },
    async disconnectSession() {
      await provider.disconnectSession();
    },
    getPermissionAuthorizationStatus(request) {
      return provider.getPermissionAuthorizationStatus(request);
    },
    getPermissionAuthorizationStatuses(requests) {
      return provider.getPermissionAuthorizationStatuses(requests);
    },
    setPermissionAuthorizationStatus(request, status) {
      return provider.setPermissionAuthorizationStatus(request, status);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribeCore();
      listeners.clear();
      provider.dispose();
    },
  };
}

let topbarLoginRequestSeq = 0;

export function requestCoreLogin(
  core: Provider,
  reason?: string,
): Promise<LoginResponse> {
  const requestId = `dotli:topbar-login:${String(++topbarLoginRequestSeq)}`;
  // Codec 2 legs carry Result outside and the version wrapper inside.
  const responseCodec = scale.Result(
    VersionedHostRequestLoginResponse,
    scale.CallError(VersionedHostRequestLoginError),
  );
  const frame = encodeWireMessage({
    requestId,
    payload: {
      traitId: ACCOUNT_REQUEST_LOGIN.trait,
      methodId: ACCOUNT_REQUEST_LOGIN.method,
      messageType: MESSAGE_TYPE_REQUEST,
      value: VersionedHostRequestLoginRequest.enc({
        tag: "V1",
        value: { reason },
      }),
    },
  });
  if (frame.isErr()) {
    return Promise.reject(frame.error);
  }

  return new Promise<LoginResponse>((resolve, reject) => {
    let settled = false;
    let cleanupRequested = false;
    let unsubscribeMessage: (() => void) | undefined;
    let unsubscribeClose: (() => void) | undefined;
    const cleanup = (): void => {
      cleanupRequested = true;
      unsubscribeMessage?.();
      unsubscribeMessage = undefined;
      unsubscribeClose?.();
      unsubscribeClose = undefined;
    };
    const registerCleanup = (
      unsubscribe: (() => void) | undefined,
      retain: (value: (() => void) | undefined) => void,
    ): void => {
      if (cleanupRequested) {
        unsubscribe?.();
      } else {
        retain(unsubscribe);
      }
    };
    const rejectRequest = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const resolveRequest = (response: LoginResponse): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(response);
    };

    registerCleanup(
      core.subscribe((message) => {
        const decoded = decodeWireMessage(message);
        if (decoded.isErr()) {
          rejectRequest(decoded.error);
          return;
        }
        const { payload } = decoded.value;
        if (
          decoded.value.requestId !== requestId ||
          payload.traitId !== ACCOUNT_REQUEST_LOGIN.trait ||
          payload.methodId !== ACCOUNT_REQUEST_LOGIN.method ||
          payload.messageType !== MESSAGE_TYPE_RESPONSE
        ) {
          return;
        }
        cleanup();
        try {
          const result = responseCodec.dec(payload.value);
          if (result.success) {
            resolveRequest(result.value.value);
          } else {
            const error = new LoginRequestError(result.value);
            rejectRequest(error);
          }
        } catch (error) {
          rejectRequest(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }),
      (unsubscribe) => {
        unsubscribeMessage = unsubscribe;
      },
    );

    registerCleanup(
      core.subscribeClose?.((error) => {
        rejectRequest(error);
      }),
      (unsubscribe) => {
        unsubscribeClose = unsubscribe;
      },
    );

    try {
      core.postMessage(frame.value);
    } catch (error) {
      rejectRequest(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function createHost(args: {
  iframeUrl: string;
  allowedOrigin: string;
  sandbox: string;
  label: string;
  productId?: string;
  archiveCid?: string;
  container: HTMLElement;
  extraAllow?: readonly string[];
  debugFlowId: string;
  viewInsetsRelay?: boolean;
}): Promise<ActiveHost> {
  const generation = renderGeneration;
  const coreProvider = await createCoreProvider(args.label, {
    productId: args.productId,
    archiveCid: args.archiveCid,
  });
  const unregisterPermissions = registerPermissionAuthorizationProvider(
    args.label,
    coreProvider,
  );
  const { createIframeHost } = await runtimeChunkPromise;
  const productId = args.productId ?? labelToProductId(args.label);
  let productProvider: Provider | null = null;
  let disposePipe: (() => void) | null = null;
  let productProbeCleanup: (() => void) | null = null;
  let disposeViewInsets: (() => void) | null = null;
  const pipeArgs = {
    flowId: args.debugFlowId,
    label: args.label,
    productId,
  };
  const cleanupProductSide = (): void => {
    disposePipe?.();
    productProvider?.dispose();
    disposePipe = null;
    productProvider = null;
  };
  const connectProductPort = (port: MessagePort): void => {
    cleanupProductSide();
    productProvider = createMessagePortProvider(port);
    disposePipe = pipeProviders(productProvider, coreProvider, pipeArgs);
  };
  try {
    const allow = [
      await buildAllowAttribute(args.label),
      ...(args.extraAllow ?? []),
      "cross-origin-isolated",
    ].join("; ");
    const host = createIframeHost({
      iframeUrl: args.iframeUrl,
      allowedOrigin: args.allowedOrigin,
      allow,
      sandbox: args.sandbox,
      container: args.container,
      onPort: connectProductPort,
    });
    if (args.viewInsetsRelay === true) {
      disposeViewInsets = installPolkaVmViewInsetsRelay(
        host.iframe,
        args.allowedOrigin,
      );
    }

    // Codec-1 Nova products post raw SCALE frames to window.parent. Those
    // bytes have no codec marker and must never reach the codec-2 decoder.
    // Only the modern SDK's transferred MessagePort is supported.
    let probeMode: "pending" | "modern" = "pending";
    let warnedLegacyTransport = false;
    const onProbe = (event: MessageEvent): void => {
      const targetWindow = host.iframe.contentWindow;
      if (
        !targetWindow ||
        event.source !== targetWindow ||
        event.origin !== args.allowedOrigin
      ) {
        return;
      }
      if ((event.data as { type?: unknown } | null)?.type === "truapi-ready") {
        if (probeMode === "modern") {
          const channel = new MessageChannel();
          connectProductPort(channel.port1);
          targetWindow.postMessage(
            { type: "truapi-init" },
            args.allowedOrigin,
            [channel.port2],
          );
        } else {
          probeMode = "modern";
        }
        return;
      }
      if (event.data instanceof Uint8Array && !warnedLegacyTransport) {
        warnedLegacyTransport = true;
        showNotification({
          text: "This product uses the unsupported legacy Nova host API. Update it to @parity/truapi 0.16 or newer with the MessagePort transport.",
          label: "Product update required",
          browserNotification: false,
        });
      }
    };
    window.addEventListener("message", onProbe);
    productProbeCleanup = () => {
      window.removeEventListener("message", onProbe);
      productProbeCleanup = null;
    };

    return {
      core: coreProvider,
      generation,
      iframe: host.iframe,
      requestLogin(reason) {
        return requestCoreLogin(coreProvider, reason);
      },
      cancelLogin() {
        coreProvider.cancelPairing();
      },
      disconnect() {
        return coreProvider.disconnectSession();
      },
      dispose() {
        mediatedInputHost.stop();
        unregisterPermissions();
        disposeViewInsets?.();
        productProbeCleanup?.();
        cleanupProductSide();
        coreProvider.dispose();
        host.dispose();
      },
    };
  } catch (error) {
    disposeViewInsets?.();
    unregisterPermissions();
    productProbeCleanup?.();
    cleanupProductSide();
    coreProvider.dispose();
    throw error;
  }
}

async function createCoreProvider(
  label: string,
  options: {
    pairingLabel?: string;
    pairingDotSuffix?: boolean;
    pairingHostGlobal?: boolean;
    productId?: string;
    archiveCid?: string;
    walletOwner?: boolean;
  } = {},
): Promise<CoreProvider> {
  if (blockingModalCoordinator === null) {
    throw new Error(
      "TrUAPI bridge initialized without a blocking modal coordinator",
    );
  }
  await initializeLocalWalletState();
  // Bootstrap the persistent owner first; products never own wallet identity.
  const owner =
    isExperimentalWalletActive() && options.walletOwner !== true
      ? await activeLocalWallet()
      : undefined;
  const blockingModalScope = blockingModalCoordinator.createScope();
  const localContext = isExperimentalWalletActive()
    ? localWalletContext()
    : undefined;
  let activatedIdentity: LocalIdentity | undefined;
  let nativeSessionUiInfo: LiveLocalWallet["nativeSessionUiInfo"];
  let liveWallet: LiveLocalWallet | undefined;
  let walletAuthReady = false;
  let pendingWalletAuthState: AuthState | undefined;
  let runtimeDisposed = false;
  const isRuntimeDisposed = (): boolean => runtimeDisposed;
  let runtime: WorkerPairingHostRuntime | WorkerSigningHostRuntime | undefined;
  const disposeNativeRuntime = (): void => {
    runtimeDisposed = true;
    localRuntimeDisposers.delete(disposeNativeRuntime);
    if (liveWallet !== undefined) {
      liveLocalWallets.delete(liveWallet.runtime);
    }
    runtime?.dispose();
  };
  localRuntimeDisposers.add(disposeNativeRuntime);
  try {
    const { createWebWorkerPairingHostRuntime, HostWorker } =
      await runtimeChunkPromise;
    const runtimeConfig = createTruapiRuntimeConfig(label, options.productId);
    const { productId, ...hostConfig } = runtimeConfig;
    // Chat-capable products get a Worker-kind execution so the core serves
    // their chat calls; everything an App connection can do still works.
    // The capability is primed by the host shell before rendering, so
    // this await settles from cache or the in-flight manifest read.
    const chatCapable =
      options.walletOwner !== true && (await chatCapabilityFor(label));
    const callbacks = createHostCallbacks({
      label,
      pairingLabel: options.pairingLabel,
      pairingDotSuffix: options.pairingDotSuffix,
      pairingHostGlobal: options.pairingHostGlobal,
      blockingModalScope,
    });
    const forwardAuthState = callbacks.auth.authStateChanged;
    callbacks.auth.authStateChanged = (state) => {
      // Worker messages queued before replacement must never repaint a new
      // identity or overwrite the separate Mobile session UI cache.
      if (
        isRuntimeDisposed() ||
        (localContext === undefined
          ? isExperimentalWalletActive()
          : !isCurrentLocalWallet(localContext))
      ) {
        return;
      }
      if (localContext !== undefined && state.tag === "Connected") {
        const account = state.value.identityAccountId;
        if (account !== undefined && /^(?:0x)?[0-9a-fA-F]{64}$/.test(account)) {
          activatedIdentity = {
            identityAccountId: `0x${account.replace(/^0x/, "").toLowerCase()}`,
            ...((state.value.liteUsername ?? "") !== ""
              ? { liteUsername: state.value.liteUsername }
              : {}),
          };
          nativeSessionUiInfo = {
            publicKey: state.value.publicKey,
            fullUsername: state.value.fullUsername,
          };
          if (
            liveWallet !== undefined &&
            activatedIdentity.identityAccountId !==
              liveWallet.binding.identityAccountId
          ) {
            return;
          }
          if (liveWallet !== undefined) {
            liveWallet.identity = activatedIdentity;
            liveWallet.nativeSessionUiInfo = nativeSessionUiInfo;
          }
        }
      }
      if (localContext === undefined) {
        forwardAuthState(state);
      } else if (options.walletOwner === true) {
        // Activation reports Connected before chain restoration. Publish only
        // the final restored native session, never a transient bare identity.
        if (walletAuthReady) {
          forwardAuthState(state);
        } else {
          pendingWalletAuthState = state;
        }
      }
    };
    if (localContext !== undefined) {
      const secret = await readLocalWalletSecret();
      if (secret === undefined) {
        throw new Error(
          "Experimental wallet is unavailable. Disconnect it in the debug bar.",
        );
      }
      try {
        const { createWebWorkerSigningHostRuntime } = await runtimeChunkPromise;
        const signing = await createWebWorkerSigningHostRuntime(
          new HostWorker(),
          callbacks,
          {
            hostConfig: {
              ...hostConfig,
              networkSuffix: getActiveServicesConfig().dotns.TLD,
            },
          },
        );
        runtime = signing;
        if (isRuntimeDisposed() || !isCurrentLocalWallet(localContext)) {
          throw new Error(
            "Test wallet changed while the signing worker was starting.",
          );
        }
        await signing.activateLocalSession(secret);
        if (
          isRuntimeDisposed() ||
          !isCurrentLocalWallet(localContext) ||
          activatedIdentity === undefined
        ) {
          throw new Error(
            "Test wallet changed or native activation did not report its identity.",
          );
        }
        const binding: LocalWalletIdentityBinding = {
          ...localContext,
          identityAccountId: activatedIdentity.identityAccountId,
        };
        await withLocalIdentityUpdate(async () => {
          if (owner !== undefined) {
            assertInspectorWallet(owner);
            if (owner.binding.identityAccountId !== binding.identityAccountId) {
              throw new Error(
                "The product activated a different test identity.",
              );
            }
          }
          const usernameHint =
            owner === undefined
              ? (await readVerifiedLocalIdentity(binding))?.liteUsername
              : owner.identity.liteUsername;
          if (isRuntimeDisposed() || !isCurrentLocalWallet(binding)) {
            throw new Error("Test wallet changed during username restoration.");
          }
          if (usernameHint !== undefined) {
            // Neither disk hints nor another runtime's session prove this
            // product's native identity. Verify without resetting its grants.
            activatedIdentity = await signing.refreshLocalIdentity();
            if (
              activatedIdentity.identityAccountId !== binding.identityAccountId
            ) {
              throw new Error(
                "Restored username did not match the active wallet.",
              );
            }
          }
          if (
            isRuntimeDisposed() ||
            !isCurrentLocalWallet(binding) ||
            activatedIdentity === undefined
          ) {
            throw new Error("Test wallet changed during native activation.");
          }
          liveWallet = {
            runtime: signing,
            binding,
            identity: activatedIdentity,
            nativeSessionUiInfo,
          };
          liveLocalWallets.set(signing, liveWallet);
        });
      } finally {
        secret.fill(0);
      }
    } else {
      runtime = await createWebWorkerPairingHostRuntime(
        new HostWorker(),
        callbacks,
        { hostConfig },
      );
      if (isRuntimeDisposed() || isExperimentalWalletActive()) {
        throw new Error(
          "Wallet mode changed while the Mobile worker was starting.",
        );
      }
    }
    const provider = await runtime.createProvider({
      productId,
      executionKind: chatCapable ? "Worker" : "App",
    });
    if (
      isRuntimeDisposed() ||
      (localContext === undefined
        ? isExperimentalWalletActive()
        : !isCurrentLocalWallet(localContext))
    ) {
      provider.dispose();
      throw new Error(
        "Wallet changed while the product provider was starting.",
      );
    }
    const unregisterChat = chatCapable
      ? registerChatConnection(productId, {
          loadRendererImage: createRendererImageLoader(options.archiveCid),
          publish: (action) =>
            provider.publishChatAction === undefined
              ? Promise.reject(new Error("chat publishing unavailable"))
              : provider.publishChatAction(action),
          publishRendererAction: (action) =>
            provider.publishRendererAction === undefined
              ? Promise.reject(new Error("renderer publishing unavailable"))
              : provider.publishRendererAction(action),
          render: (request, sink) => {
            if (provider.render === undefined) {
              sink.onError?.(new Error("rendering unavailable"));
              return noop;
            }
            return provider.render(request, sink);
          },
        })
      : noop;
    let unsubscribeOwnerClose: (() => void) | undefined;
    const tracked = trackCoreProvider(
      wrapCoreProviderForDebug(provider, productId),
      runtime,
      () => {
        runtimeDisposed = true;
        unsubscribeOwnerClose?.();
        localRuntimeDisposers.delete(disposeNativeRuntime);
        if (liveWallet !== undefined) {
          liveLocalWallets.delete(liveWallet.runtime);
          providerWallets.delete(tracked);
        }
        unregisterChat();
        blockingModalScope.dispose();
      },
    );
    if (liveWallet !== undefined) {
      providerWallets.set(tracked, liveWallet);
    }
    runtime = undefined;
    if (options.walletOwner === true) {
      if (liveWallet !== undefined) {
        let closeError: Error | undefined;
        unsubscribeOwnerClose = tracked.subscribeClose?.((error) => {
          if (isRuntimeDisposed()) {
            return;
          }
          closeError = error;
          disposeLandingAuthHost();
          tracked.dispose();
          dispatchAuthState({
            tag: "WalletUnavailable",
            reason: error.message,
          });
        });
        // Subscription can synchronously report an already-closed provider.
        // Do not publish Connected or return its retired native authority.
        if (closeError !== undefined) {
          unsubscribeOwnerClose?.();
          throw closeError;
        }
      }
      walletAuthReady = true;
      if (pendingWalletAuthState !== undefined) {
        forwardAuthState(pendingWalletAuthState);
        pendingWalletAuthState = undefined;
      }
    }
    return tracked;
  } catch (error) {
    disposeNativeRuntime();
    blockingModalScope.dispose();
    throw error;
  }
}

async function getLandingAuthHost(): Promise<CoreHost> {
  if (landingAuthHostPromise !== null) {
    return landingAuthHostPromise;
  }
  const generation = landingAuthGeneration;
  const promise = createLandingAuthHost()
    .then((host) => {
      if (
        generation !== landingAuthGeneration ||
        landingAuthHostPromise !== promise
      ) {
        host.dispose();
        throw new Error(
          "Landing auth host was disposed before it became ready",
        );
      }
      return host;
    })
    .catch((error: unknown) => {
      if (landingAuthHostPromise === promise) {
        landingAuthHostPromise = null;
      }
      throw error;
    });
  landingAuthHostPromise = promise;
  return promise;
}

async function createLandingAuthHost(): Promise<CoreHost> {
  const coreProvider = await createCoreProvider(LANDING_AUTH_LABEL, {
    pairingLabel: LANDING_AUTH_DISPLAY_LABEL,
    pairingDotSuffix: false,
    pairingHostGlobal: true,
    walletOwner: true,
  });
  return {
    core: coreProvider,
    requestLogin(reason) {
      return requestCoreLogin(coreProvider, reason);
    },
    cancelLogin() {
      coreProvider.cancelPairing();
    },
    disconnect() {
      return coreProvider.disconnectSession();
    },
    dispose() {
      coreProvider.dispose();
    },
  };
}

function disposeLandingAuthHost(): void {
  landingAuthGeneration++;
  const pending = landingAuthHostPromise;
  landingAuthHostPromise = null;
  void pending?.then(
    (host) => {
      host.dispose();
    },
    () => {
      /* failed pending host has nothing to dispose */
    },
  );
}

/**
 * Render a dApp iframe backed by the TrUAPI host bridge.
 */
export async function renderIframe(
  url: string,
  label: string,
  options: { productId?: string } = {},
): Promise<void> {
  const myRenderGeneration = ++renderGeneration;
  const renderFlowId = newFlowId("render");
  const bridgeFlowId = newFlowId("bridge");
  const productId = options.productId ?? label;
  emitDotliDebugEvent({
    layer: "render",
    event: "iframe_begin",
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, url, mode: "iframe" },
  });
  const stopSetup = m.timer(S.BRIDGE_SETUP);
  // Keep the current product visible while the replacement core initializes.
  // Core startup can take several seconds. Removing the old iframe first made
  // permission-triggered reloads look like a permanently blank application.
  const previousHost = currentHost;
  if (previousHost === null) {
    app.innerHTML = "";
  }
  if (!isExperimentalWalletActive()) {
    disposeLandingAuthHost();
  }

  currentProduct = {
    mode: "iframe",
    label,
    url,
    productId: options.productId,
  };

  const hasTopbar = document.getElementById("topbar") !== null;
  const iframeUrl = new URL(url, window.location.href);
  emitDotliDebugEvent({
    layer: "bridge",
    event: "setup_begin",
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId },
  });
  const host = await createHost({
    iframeUrl: iframeUrl.href,
    allowedOrigin: iframeUrl.origin,
    // Keep parity with the current dotli product sandbox permissions.
    sandbox: "allow-scripts allow-same-origin allow-forms allow-pointer-lock",
    label,
    productId: options.productId,
    container: app,
    debugFlowId: bridgeFlowId,
  });
  if (myRenderGeneration !== renderGeneration) {
    host.dispose();
    stopSetup();
    return;
  }
  emitDotliDebugEvent({
    layer: "bridge",
    event: "setup_ready",
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId },
  });
  applyIframeStyling(host.iframe, { topbarOffset: hasTopbar });
  activateHost(host, previousHost);
  host.iframe.addEventListener(
    "load",
    () => {
      emitDotliDebugEvent({
        layer: "bridge",
        event: "iframe_load",
        flowId: bridgeFlowId,
        timestamp: Date.now(),
        payload: { label, productId, mode: "iframe" },
      });
    },
    { once: true },
  );

  if (
    (import.meta.env.VITE_SANDBOX_CHECKER as string | undefined) !== undefined
  ) {
    const { setupViolationPanel } =
      await import("@dotli/sandbox-checker/sandbox-checker-ui");
    if (myRenderGeneration !== renderGeneration) {
      stopSetup();
      return;
    }
    currentPanelDispose = setupViolationPanel(host.iframe);
  }

  stopSetup();
  document.title = `${label} · dot.li`;

  // Carry the runtime productId so listeners key chat data the same way
  // storage does when the debug path overrides the label-derived id.
  window.dispatchEvent(
    new CustomEvent("dotli:product-loaded", {
      detail: {
        label,
        productId: options.productId ?? labelToProductId(label),
      },
    }),
  );
  emitDotliDebugEvent({
    layer: "render",
    event: "iframe_ready",
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, mode: "iframe" },
  });
}

function isPolkaVmExecutableManifest(value: string | null): boolean {
  if (value === null) {
    return false;
  }
  try {
    const manifest: unknown = JSON.parse(value);
    if (
      manifest === null ||
      typeof manifest !== "object" ||
      !("runtime" in manifest) ||
      manifest.runtime === null ||
      typeof manifest.runtime !== "object" ||
      !("kind" in manifest.runtime)
    ) {
      return false;
    }
    return manifest.runtime.kind === "polkavm";
  } catch {
    return false;
  }
}

/**
 * Render content in a cross-origin app subdomain iframe (cid.app.dot.li).
 * Used by the host build to delegate content fetching+rendering to the app context.
 *
 * The app context acts as a transparent relay between the host and the dApp
 * iframe. Only the app subdomain itself participates in the TrUAPI
 * MessageChannel. Any nested dApp iframe it loads is opaque to the host.
 */
export async function renderAppSubdomain(
  cid: string,
  label: string,
  executableManifest: string | null = null,
): Promise<void> {
  const myRenderGeneration = ++renderGeneration;
  const renderFlowId = newFlowId("render");
  const bridgeFlowId = newFlowId("bridge");
  const stopSetup = m.timer(S.BRIDGE_SETUP);
  // Permission changes rebuild this host so the iframe receives a refreshed
  // `allow` attribute. Keep the current product visible until its replacement
  // core and iframe are ready, just like the direct-iframe render path.
  const previousHost = currentHost;
  if (!isExperimentalWalletActive()) {
    disposeLandingAuthHost();
  }

  currentProduct = {
    mode: "subdomain",
    label,
    cid,
    executableManifest,
  };

  // Propagate the current sandbox contract. The `?mode=` preset param is no
  // longer sent. Host and sandbox deploy together, and the sandbox validator
  // rejects unknown params.
  const chainBackend = getBackend();
  const network = getNetwork();
  const cache = getCacheSettings();
  const appOrigin = sandboxOriginForLabel(label);
  const deepPath = getDeepPath();
  // One-shot: the settings popover sets this flag right before reloading so
  // the first sandbox boot after "Save & Apply" wipes its own origin too.
  // Consume and clear so subsequent navigations (permission reload, etc.)
  // don't keep triggering resets.
  let fullReset = false;
  try {
    if (sessionStorage.getItem("dotli:pending-reset:sandbox") === "1") {
      fullReset = true;
      sessionStorage.removeItem("dotli:pending-reset:sandbox");
    }
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in Safari private mode, so the reset flag defaults to false which is the safe state.
  } catch {
    /* sessionStorage unavailable, skip pending reset */
  }
  const parsedUrl = new URL(deepPath ? `${appOrigin}${deepPath}` : appOrigin);
  if (parsedUrl.origin !== appOrigin) {
    throw new Error(ERRORS.CROSS_ORIGIN_APP_URL);
  }
  parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.cid, cid);
  parsedUrl.searchParams.set(
    SANDBOX_CONTRACT_PARAMS.v,
    String(SANDBOX_SCHEMA_VERSION),
  );
  parsedUrl.searchParams.set(
    SANDBOX_CONTRACT_PARAMS.chainBackend,
    chainBackend,
  );
  parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.network, network);
  if (executableManifest !== null) {
    parsedUrl.searchParams.set(
      SANDBOX_CONTRACT_PARAMS.executableManifest,
      executableManifest,
    );
  }
  if (cache.skipArchiveCache) {
    parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.skipArchiveCache, "1");
  }
  if (fullReset) {
    parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.fullReset, "1");
  }
  const resolutionId = getResolutionId();
  if (resolutionId !== null) {
    parsedUrl.searchParams.set(
      SANDBOX_CONTRACT_PARAMS.resolutionId,
      resolutionId,
    );
  }
  const url = parsedUrl.toString();

  // Keep the loading overlay visible. The sandbox will post status
  // messages via dotli:loading-status and a final done=true to dismiss it.
  // Only prepare it on the initial render. During a permission refresh the
  // current iframe remains visible until the replacement is ready.
  const loading =
    previousHost === null ? app.querySelector<HTMLElement>(".loading") : null;
  if (previousHost === null) {
    app.innerHTML = "";
    if (loading) {
      app.appendChild(loading);
    }
  }

  const iframeUrl = new URL(url);
  const isPolkaVm = isPolkaVmExecutableManifest(executableManifest);
  emitDotliDebugEvent({
    layer: "bridge",
    event: "setup_begin",
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId: label },
  });
  emitDotliDebugEvent({
    layer: "render",
    event: "iframe_begin",
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, url, mode: "subdomain" },
  });
  const host = await createHost({
    iframeUrl: url,
    allowedOrigin: iframeUrl.origin,
    sandbox:
      "allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups",
    label,
    archiveCid: cid,
    extraAllow: isPolkaVm ? ["accelerometer", "gyroscope"] : [],
    viewInsetsRelay: isPolkaVm,
    container: app,
    debugFlowId: bridgeFlowId,
  });
  if (myRenderGeneration !== renderGeneration) {
    host.dispose();
    stopSetup();
    return;
  }
  emitDotliDebugEvent({
    layer: "bridge",
    event: "setup_ready",
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId: label },
  });
  applyIframeStyling(host.iframe, { topbarOffset: true });
  activateHost(host, previousHost, loading === null ? [] : [loading]);
  host.iframe.addEventListener(
    "load",
    () => {
      emitDotliDebugEvent({
        layer: "bridge",
        event: "iframe_load",
        flowId: bridgeFlowId,
        timestamp: Date.now(),
        payload: { label, productId: label, mode: "subdomain" },
      });
    },
    { once: true },
  );

  if (
    (import.meta.env.VITE_SANDBOX_CHECKER as string | undefined) !== undefined
  ) {
    const { setupViolationPanel } =
      await import("@dotli/sandbox-checker/sandbox-checker-ui");
    if (myRenderGeneration !== renderGeneration) {
      stopSetup();
      return;
    }
    currentPanelDispose = setupViolationPanel(host.iframe);
  }

  stopSetup();
  document.title = withActiveTld(label);

  window.dispatchEvent(
    new CustomEvent("dotli:product-loaded", {
      detail: { label, productId: labelToProductId(label) },
    }),
  );
  emitDotliDebugEvent({
    layer: "render",
    event: "iframe_ready",
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, mode: "subdomain" },
  });
}

function activateHost(
  host: ActiveHost,
  previousHost: ActiveHost | null,
  retainedChildren: readonly HTMLElement[] = [],
): void {
  stopMotionRelay();
  mediatedInputHost.stop();
  if (currentPanelDispose) {
    currentPanelDispose();
    currentPanelDispose = null;
  }
  previousHost?.dispose();
  const retained = new Set<HTMLElement>([host.iframe, ...retainedChildren]);
  for (const child of [...app.children]) {
    if (!retained.has(child as HTMLElement)) {
      child.remove();
    }
  }
  currentHost = host;
}

function newFlowId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${prefix}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
}
