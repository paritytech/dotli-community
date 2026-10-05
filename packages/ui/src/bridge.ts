// dot.li TrUAPI host bridge
//
// Connects the page's TrUAPI core (see page-core.ts) to a sandboxed product
// iframe via `@parity/truapi-host`, and routes the topbar's login, pairing
// cancel and logout to that same core. Each render swaps the iframe and its
// connection; the core stays for as long as anything holds it.
//
// Nested dApp-in-dApp composition is not modeled as separate Rust runtimes,
// sessions, product identities, or storage namespaces. Any future nested
// traffic must share the top-level core/provider context.

import {
  AllocatableResource,
  createClient,
  createTransport,
  type TrUApiClient,
  decodeWireMessage,
  encodeWireMessage,
  MESSAGE_TYPE_REQUEST,
  MESSAGE_TYPE_RESPONSE,
  scale,
  VersionedHostRequestLoginError,
  VersionedHostRequestLoginRequest,
  VersionedHostRequestLoginResponse,
  type HostRequestLoginResponse as LoginResponse,
  type WireProvider as Provider,
  createMessagePortProvider,
} from '@parity/truapi';
import { ACCOUNT_REQUEST_LOGIN } from '@parity/truapi/wire-table';
import {
  DEBUG,
  getActiveServicesConfig,
  SANDBOX_CONTRACT_PARAMS,
  SANDBOX_SCHEMA_VERSION,
  getBackend,
  getPolkaVmAppsEnabled,
  SITE_ID,
  sandboxOriginForLabel,
  getNetwork,
  withActiveTld,
} from '@dotli/config';

import { getResolutionId, m, spans as S } from '@dotli/metrics';
import { chatCapabilityFor, log } from '@dotli/shared';

import { emitDotliDebugEvent, hasDotliDebugListeners } from '@dotli/truapi-debug';
import type { TrUApiProductProvider } from '@parity/truapi-host';
import { createIframeHost } from '@parity/truapi-host/web';
import { buildAllowAttribute, registerPermissionAuthorizationProvider } from './permissions.js';
import { dispatchAuthState } from './host-callbacks/AuthState.js';
import { createContactAvatars, installProfileDebugTrigger } from './host-callbacks/Profile.js';
import type { AvatarSurfaceFit } from './profile/avatar-overlay.js';
import { createContactLabelOverlay } from './contacts/label-overlay.js';
import { LoginRequestError } from './login-request-error.js';
import { attachProductFrame } from './product-frame-layout.js';
import { labelToProductId } from './runtime-config.js';
import {
  acquireCore,
  cancelPairing,
  initPageCore,
  setPageProduct,
  activeLocalWallet,
  assertLocalWallet,
  disposePageCores,
  withLocalIdentityUpdate,
  type LiveLocalWallet,
  type CoreConnection,
} from './page-core.js';
import type { InspectorProduct } from '@dotli/truapi-debug';
import type { LocalIdentity, LocalIdentityProgress, WalletAllowanceSnapshot } from '@parity/truapi-host/web';
import { ALL_PERMISSIONS, authorizationRequest, fromAuthorizationStatus } from './permissions.js';
import {
  createLocalWalletSecret,
  deleteLocalWalletSecret,
  exportLocalWalletMnemonic,
  importLocalWalletMnemonic,
  isExperimentalWalletActive,
  initializeLocalWalletState,
  isLocalWalletStoredInOtherApp,
  setLocalWalletEnabled,
  readLocalWalletDisplay,
  writeVerifiedLocalIdentity,
  LOCAL_WALLET_ENABLED_KEY,
  LOCAL_WALLET_REVISION_KEY,
} from './host-callbacks/SessionStore.js';

export { setPageProduct } from './page-core.js';
// The host boot already awaits this module, and the pool behind these leases
// is already in it (through the page core's callbacks), so the gateway
// resolver and the settings probe take their leases from here rather than
// from a chunk of their own.
export { hostAssetHubProvider, hostChainProvider } from './host-callbacks/Chain.js';
import { setProductLoaded } from './state/product.js';
import { describeWireFrame } from './debug-wire-describe.js';
import type { BlockingModalCoordinator } from './blocking-modal-queue.js';
import { createRendererImageLoader, registerChatConnection } from './chat/service.js';
import { showNotification } from './notification.js';
import { registerProductNotificationTarget } from './notification-activation.js';
import { ERRORS } from './errors.js';
import { disposeAppRoot, disposeAppRoots } from './mount/app-roots.js';
import { jamPeerTransportUnavailableMessage } from './jam-peer-browser-support.js';
import { mountViolationPanel } from './components/sandbox-checker/mount.js';
import { CameraInputCancelledError, CameraInputPermissionError, scanCameraUr } from './mediated-input-camera.js';
import { MediatedInputHost, validatedMediatedInputRequest } from './mediated-input-host.js';
import { decidePromptPermission } from './host-callbacks/PromptPermission.js';
import { createSubmitRateLimiter } from './host-callbacks/rate-limit.js';
import { installPolkaVmViewInsetsRelay } from './polkavm-view-insets.js';
import { revokeReceivingOnLogout, setReceivingActivation, receivingAccount } from './receiving.js';
import type { ReceivingExecution } from './receiving-execution.js';
import type { ReceivingAuthority } from '@parity/truapi-host/browser-receiving';

const noop = (): void => undefined;

const app = document.getElementById('app') ?? document.body;

interface ActiveHost {
  core: CoreProviderBase;
  wallet: LiveLocalWallet | undefined;
  generation: number;
  iframe: HTMLIFrameElement;
  receiving: ReceivingExecution;
  dispose: () => void;
}

type CoreProviderBase = Provider &
  Pick<
    TrUApiProductProvider,
    'getPermissionAuthorizationStatus' | 'getPermissionAuthorizationStatuses' | 'setPermissionAuthorizationStatus'
  >;
type CurrentProduct =
  | {
      mode: 'iframe';
      label: string;
      url: string;
      productId?: string | undefined;
    }
  | {
      mode: 'subdomain';
      label: string;
      cid: string;
      executableManifest: string | null;
    };

let currentHost: ActiveHost | null = null;
let currentPanelDispose: (() => void) | null = null;
let currentProduct: CurrentProduct | null = null;
let renderGeneration = 0;
let blockingModalCoordinator: BlockingModalCoordinator | null = null;
const mediatedInputPermissionLimiter = createSubmitRateLimiter();
const mediatedInputHost = new MediatedInputHost({
  authorize: async (label, signal) => {
    const coordinator = blockingModalCoordinator;
    if (coordinator === null) {
      throw new Error('blocking modal coordinator is unavailable');
    }
    const scope = coordinator.createScope();
    const abort = (): void => {
      scope.dispose('mediated input cancelled');
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const decision = await decidePromptPermission(
        label,
        'Camera',
        {
          kind: 'Device',
          limiter: mediatedInputPermissionLimiter,
          gatedByIframe: false,
        },
        scope,
      );
      return decision !== 'Deny';
    } finally {
      signal.removeEventListener('abort', abort);
      scope.dispose();
    }
  },
  scan: (label, request, signal) => scanCameraUr(label, request, signal),
  send: (owner, handle, status, bytes) => {
    const product = currentProduct;
    const source = currentHost?.iframe.contentWindow;
    if (product?.mode !== 'subdomain' || source === null || source === undefined || owner !== source) {
      return;
    }
    if (bytes === undefined) {
      source.postMessage(
        {
          type: 'dotli:polkavm-mediated-input-result',
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
        type: 'dotli:polkavm-mediated-input-result',
        handle,
        status,
        bytes: result,
      },
      sandboxOriginForLabel(product.label),
      [result.buffer],
    );
  },
  isCancellation: error =>
    error instanceof CameraInputCancelledError || (error instanceof DOMException && error.name === 'AbortError'),
  isPermissionDenied: error => error instanceof CameraInputPermissionError,
});

let localIdentityOperationPending = false;

async function updateLocalIdentity(
  baseUsername?: string,
  onProgress?: (progress: LocalIdentityProgress) => void,
): Promise<LocalIdentity> {
  if (localIdentityOperationPending) {
    throw new Error('A username operation is already pending.');
  }
  localIdentityOperationPending = true;
  try {
    const wallet = await activeLocalWallet();
    return await withLocalIdentityUpdate(async () => {
      assertLocalWallet(wallet);
      const identity =
        baseUsername === undefined
          ? await wallet.runtime.refreshLocalIdentity()
          : await wallet.runtime.registerLocalLiteUsername(
              baseUsername,
              new URL(getActiveServicesConfig().identityBackendBaseUrl, window.location.origin).href,
              onProgress === undefined
                ? undefined
                : progress => {
                    try {
                      assertLocalWallet(wallet);
                    } catch {
                      return;
                    }
                    onProgress(progress);
                  },
            );
      assertLocalWallet(wallet);
      if (
        identity.identityAccountId !== wallet.binding.identityAccountId ||
        (baseUsername !== undefined && (identity.liteUsername?.trim() ?? '') === '')
      ) {
        throw new Error('Native username confirmation did not match the active identity.');
      }
      // Every page connection sees the same native session update; no second
      // product runtime needs reactivation (which would reset its grants).
      wallet.identity = identity;
      wallet.usernameVerified = true;
      if (baseUsername !== undefined && identity.liteUsername !== undefined) {
        showNotification({
          text: identity.liteUsername + ' is confirmed on-chain and ready to use.',
          label: 'Username claimed',
          browserNotification: false,
        });
      }
      try {
        await writeVerifiedLocalIdentity(wallet.binding, identity);
      } catch {
        throw new Error(
          'Chain confirmed ' +
            (identity.liteUsername ?? 'no registered Lite username') +
            ', but saving shared metadata failed. Use Check username to retry; do not submit another claim.',
        );
      }
      assertLocalWallet(wallet);
      return identity;
    });
  } finally {
    localIdentityOperationPending = false;
  }
}

const INSPECTOR_REQUEST_PREFIX = 'dotli:host-inspector:';
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
  assertLocalWallet(wallet);
}

function inspectorProductContext(): InspectorProductContext | null {
  const product = currentProduct;
  const host = currentHost;
  if (product === null) {
    return null;
  }
  const wallet = host?.wallet;
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
      product.mode === 'iframe'
        ? (product.productId ?? labelToProductId(product.label))
        : labelToProductId(product.label),
    assertCurrent(): void {
      assertInspectorWallet(wallet);
      if (currentProduct !== product || currentHost !== host || generation !== renderGeneration) {
        throw new Error(
          'The product changed during the Wallet tab operation. An allocation already submitted may have completed; check its outcome before making another request.',
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
      return context.host.core.subscribe(message => {
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
  if (typeof input !== 'object' || input === null || typeof canonical !== 'object' || canonical === null) {
    return false;
  }
  const actual = input as Record<string, unknown>;
  const expected = canonical as Record<string, unknown>;
  return (
    Object.keys(actual).every(key => actual[key] === undefined || Object.hasOwn(expected, key)) &&
    Object.keys(expected).every(key => matchesResourceValue(actual[key], expected[key]))
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
    if (request.tag === 'AutoSigning' || !matchesResourceValue(resource, request)) {
      return null;
    }
    const selector = request.value as unknown;
    const suffix =
      typeof selector === 'object' &&
      selector !== null &&
      'tag' in selector &&
      'value' in selector &&
      (selector.tag === 'Index' || selector.tag === 'Raw')
        ? ` (${selector.tag} ${String(selector.value)})`
        : '';
    return {
      id: Array.from(encoded, byte => byte.toString(16).padStart(2, '0')).join(''),
      label: request.tag.replace(/([a-z])([A-Z])/g, '$1 $2') + suffix,
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
    throw new Error('Native permission status response was incomplete.');
  }
  let accountPublicKey: string | undefined;
  let accountError: string | undefined;
  try {
    const result = await withInspectorClient(context, client =>
      client.account.getAccount({
        productAccountId: {
          dotNsIdentifier: context.id,
          derivationIndex: { tag: 'Index', value: 0 },
        },
      }),
    );
    if (result.isErr()) {
      accountError = 'Native host did not disclose this product account.';
    } else {
      accountPublicKey = result.value.account.publicKey;
    }
  } catch (error) {
    context.assertCurrent();
    accountError = error instanceof Error ? error.message : 'Product account lookup failed.';
  }
  context.assertCurrent();
  const defaults: AllocatableResource[] = [
    { tag: 'StatementStoreAllowance' },
    { tag: 'BulletinAllowance' },
    { tag: 'SmartContractAllowance', value: { tag: 'Index', value: 0 } },
  ];
  return {
    id: context.id,
    name: context.product.label,
    origin:
      context.product.mode === 'iframe'
        ? new URL(context.product.url, window.location.href).origin
        : sandboxOriginForLabel(context.product.label),
    accountPublicKey,
    accountError,
    derivation: `ProductAccountId: ${context.id}; derivationIndex: Index 0 (native product-scoped account, not a BIP-44 path).`,
    permissions: ALL_PERMISSIONS.map(({ name, label }, index) => {
      const status = statuses[index];
      if (status === undefined) {
        throw new Error('Native permission status response was incomplete.');
      }
      return { id: name, label, status: fromAuthorizationStatus(status) };
    }),
    resources: defaults.flatMap(resource => {
      const description = describeResource(resource);
      return description === null ? [] : [description];
    }),
  };
}

async function getInspectorAllowanceSnapshot(): Promise<WalletAllowanceSnapshot> {
  const product = currentProduct;
  const generation = renderGeneration;
  const network = getNetwork();
  const networkSuffix = getActiveServicesConfig().dotns.TLD;
  const productIds =
    product === null
      ? []
      : [
          product.mode === 'iframe'
            ? (product.productId ?? labelToProductId(product.label))
            : labelToProductId(product.label),
        ];
  const wallet = await activeLocalWallet();
  const assertCurrent = (): void => {
    if (product !== currentProduct || generation !== renderGeneration || network !== getNetwork()) {
      throw new Error('The wallet inspection context changed. Refresh the Wallet tab.');
    }
    assertInspectorWallet(wallet);
  };
  assertCurrent();
  const snapshot = await wallet.runtime.getWalletAllowanceSnapshot(productIds);
  assertCurrent();
  if (
    snapshot.identityAccountId !== wallet.binding.identityAccountId ||
    snapshot.networkSuffix !== networkSuffix ||
    snapshot.productIds.length !== productIds.length ||
    snapshot.productIds.some((id, index) => id !== productIds[index])
  ) {
    throw new Error('Native allowance inspection returned a different wallet or product scope.');
  }
  return snapshot;
}

async function requestInspectorResource(
  productId: string,
  resource: unknown,
): Promise<'Allocated' | 'Rejected' | 'NotAvailable'> {
  if (inspectorResourcePending) {
    throw new Error('A resource request is already pending.');
  }
  const context = inspectorProductContext();
  if (context?.id !== productId) {
    throw new Error('Select the current product before requesting an allowance.');
  }
  const description = describeResource(resource);
  if (description === null) {
    throw new Error('Unsupported allowance request. Auto-signing is a permission, not an allowance.');
  }
  inspectorResourcePending = true;
  try {
    // This is the same native product provider and its host confirmation flow.
    // An outcome is not a balance: the API exposes no remaining-quota counter.
    const result = await withInspectorClient(context, client =>
      client.resourceAllocation.request({ resources: [description.request] }),
    );
    if (result.isErr()) {
      throw new Error('Native resource allocation failed.', {
        cause: result.error,
      });
    }
    if (result.value.outcomes.length !== 1) {
      throw new Error('Native allocation returned no unique outcome. Do not retry blindly.');
    }
    const outcome = result.value.outcomes[0];
    if (outcome === undefined) {
      throw new Error('Native allocation outcome missing');
    }
    return outcome;
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
    return display === undefined ? undefined : { ...display, network: getActiveServicesConfig().label };
  },
  async storedInOtherApp(): Promise<boolean> {
    try {
      await initializeLocalWalletState();
    } catch (error) {
      log.warn('[dot.li] Shared wallet state unavailable:', error);
      return false;
    }
    return isLocalWalletStoredInOtherApp();
  },
  async getIdentity(): Promise<
    LocalIdentity & {
      network: string;
      publicKey?: string | undefined;
      fullUsername?: string | undefined;
      usernameVerified: boolean;
    }
  > {
    const wallet = await activeLocalWallet();
    assertInspectorWallet(wallet);
    return {
      ...wallet.identity,
      usernameVerified: wallet.usernameVerified,
      ...wallet.nativeSessionUiInfo,
      network: getActiveServicesConfig().label,
    };
  },
  getProduct: getInspectorProduct,
  getAllowanceSnapshot: getInspectorAllowanceSnapshot,
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
    if (username === '' || username.includes('.')) {
      return Promise.reject(new Error('Enter a base username only, without a network suffix.'));
    }
    return updateLocalIdentity(username, onProgress);
  },
  async activate(): Promise<void> {
    if (!DEBUG) {
      throw new Error('Experimental wallets require a debug build');
    }
    const { secret } = await createLocalWalletSecret();
    secret.fill(0);
    disposePageCores();
    await setLocalWalletEnabled(true);
    window.location.reload();
  },
  async disconnect(): Promise<void> {
    if (!DEBUG) {
      return Promise.reject(new Error('Experimental wallets require a debug build'));
    }
    await revokeReceivingOnLogout();
    if (isExperimentalWalletActive()) {
      disposePageCores();
    }
    await setLocalWalletEnabled(false);
    window.location.reload();
  },
  async exportMnemonic(): Promise<string> {
    if (!DEBUG) {
      throw new Error('Experimental wallets require a debug build');
    }
    return exportLocalWalletMnemonic();
  },
  async importMnemonic(mnemonic: string): Promise<void> {
    if (!DEBUG) {
      throw new Error('Experimental wallets require a debug build');
    }
    await importLocalWalletMnemonic(mnemonic, () => {
      disposePageCores();
    });
    await setLocalWalletEnabled(true);
    window.location.reload();
  },
  async deleteWallet(): Promise<void> {
    if (!DEBUG) {
      throw new Error('Experimental wallets require a debug build');
    }
    await revokeReceivingOnLogout();
    if (isExperimentalWalletActive()) {
      disposePageCores();
    }
    await deleteLocalWalletSecret();
    await setLocalWalletEnabled(false);
    window.location.reload();
  },
};

function rerenderProduct(product: CurrentProduct): void {
  const expectedGeneration = renderGeneration + 1;
  const render =
    product.mode === 'iframe'
      ? renderIframe(product.url, product.label, {
          productId: product.productId,
        })
      : renderAppSubdomain(product.cid, product.label, product.executableManifest);
  void render.catch((error: unknown) => {
    // A newer render superseded this one, so its result owns the UI now.
    if (renderGeneration !== expectedGeneration) {
      return;
    }
    log.error('[dot.li] Product iframe reload failed:', error);
    showNotification({
      label: 'dot.li',
      text: 'The app could not be reloaded.',
      browserNotification: false,
      dismissMs: 0,
      action: {
        label: 'Reload',
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
window.addEventListener('dotli:device-permission-changed', () => {
  const product = currentProduct;
  if (product !== null) {
    rerenderProduct(product);
  }
});

window.addEventListener('dotli:receiving-account-changed', () => {
  currentHost?.receiving.close();
  if (currentHost && currentProduct) {
    rerenderProduct(currentProduct);
  }
});

window.addEventListener('dotli:receiving-error', event => {
  showNotification({
    label: 'Background receiving',
    text: String((event as CustomEvent<unknown>).detail),
    browserNotification: false,
  });
});

window.addEventListener('dotli:receiving-ready', event => {
  const { authority, archiveCid } = (event as CustomEvent<{ authority: ReceivingAuthority; archiveCid: string }>)
    .detail;
  if (
    currentHost?.receiving.matches(authority) !== true ||
    currentProduct?.mode !== 'subdomain' ||
    currentProduct.cid !== archiveCid
  ) {
    return;
  }
  try {
    localStorage.setItem(
      `dotli:receiving-target:${authority.productId}:${authority.artifact}`,
      JSON.stringify(currentProduct),
    );
  } catch (error) {
    // Existing executions can still activate; unavailable persistence cannot
    // authorize opening an unverified replacement.
    log.warn('[dot.li] Background receiving click target could not be persisted:', error);
  }
});

setReceivingActivation(async authority => {
  if (authority.account !== receivingAccount()) {
    return false;
  }
  if (currentHost?.receiving.matches(authority) !== true) {
    try {
      const raw = localStorage.getItem(`dotli:receiving-target:${authority.productId}:${authority.artifact}`);
      if (raw !== null) {
        const target: unknown = JSON.parse(raw);
        if (
          typeof target === 'object' &&
          target !== null &&
          'mode' in target &&
          target.mode === 'subdomain' &&
          'label' in target &&
          typeof target.label === 'string' &&
          labelToProductId(target.label) === authority.productId &&
          'cid' in target &&
          typeof target.cid === 'string' &&
          'executableManifest' in target &&
          (target.executableManifest === null || typeof target.executableManifest === 'string') &&
          (currentProduct?.mode !== 'subdomain' || currentProduct.cid !== target.cid)
        ) {
          // Re-open only the host's retained verified launch descriptor. The
          // notification route is opaque data, not a navigation target.
          await renderAppSubdomain(target.cid, target.label, target.executableManifest);
        }
      }
    } catch {
      return false;
    }
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && authority.account === receivingAccount()) {
    if (currentHost?.receiving.matches(authority) === true) {
      window.focus();
      currentHost.iframe.focus();
      // The worker queues the canonical Activation event only after this
      // verified readiness acknowledgement. Never navigate the event route.
      return true;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
  return false;
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

function sendMotionStatus(source: Window, origin: string, availability: 0 | 1 | 2): void {
  source.postMessage({ type: 'dotli:polkavm-motion-status', availability }, origin);
}

function offerTopLevelMotionPermission(source: Window, origin: string, label: string): void {
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
    text: 'Enable motion to tilt this application with your device.',
    dismissMs: 0,
    browserNotification: false,
    action: {
      label: 'Enable motion',
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
          typeof DeviceMotionEvent === 'undefined'
            ? null
            : (DeviceMotionEvent as typeof DeviceMotionEvent & {
                requestPermission?: () => Promise<'granted' | 'denied'>;
              });
        let request: Promise<'granted' | 'denied' | 'unavailable'>;
        try {
          request =
            constructor === null
              ? Promise.resolve('unavailable')
              : typeof constructor.requestPermission === 'function'
                ? constructor.requestPermission()
                : Promise.resolve('granted');
        } catch {
          permissionPending = false;
          sendMotionStatus(source, origin, 2);
          return;
        }
        void request
          .then(permission => {
            if (currentHost?.iframe.contentWindow !== source || currentProduct?.mode !== 'subdomain') {
              return;
            }
            if (permission === 'unavailable') {
              sendMotionStatus(source, origin, 0);
              return;
            }
            if (permission !== 'granted') {
              sendMotionStatus(source, origin, 2);
              return;
            }
            const onMotion = (event: DeviceMotionEvent): void => {
              const acceleration = event.accelerationIncludingGravity;
              const rotation = event.rotationRate;
              source.postMessage(
                {
                  type: 'dotli:polkavm-motion-sample',
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
            window.addEventListener('devicemotion', onMotion);
            motionRelayCleanup = () => {
              window.removeEventListener('devicemotion', onMotion);
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
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as Record<string, unknown> | null;
  const type = data?.['type'];
  if (
    type !== 'dotli:sandbox-recover' &&
    type !== 'dotli:host-update-required' &&
    type !== 'dotli:jam-peer-transport-unavailable' &&
    type !== 'dotli:polkavm-motion-request' &&
    type !== 'dotli:polkavm-mediated-input-request' &&
    type !== 'dotli:polkavm-mediated-input-cancel'
  ) {
    return;
  }
  const product = currentProduct;
  const source = currentHost?.iframe.contentWindow;
  if (
    product?.mode !== 'subdomain' ||
    event.origin !== sandboxOriginForLabel(product.label) ||
    source === null ||
    source === undefined ||
    event.source !== source
  ) {
    return;
  }
  if (type === 'dotli:jam-peer-transport-unavailable') {
    if (typeof Reflect.get(globalThis, 'WebTransport') !== 'function') {
      showNotification({
        label: 'Live JAM unavailable',
        text: jamPeerTransportUnavailableMessage(navigator.userAgent),
        dismissMs: 0,
        browserNotification: false,
      });
    }
    return;
  }
  if (type === 'dotli:polkavm-motion-request') {
    offerTopLevelMotionPermission(source, event.origin, product.label);
    return;
  }
  if (type === 'dotli:polkavm-mediated-input-request') {
    const request = validatedMediatedInputRequest(data);
    if (request !== null) {
      mediatedInputHost.request(source, product.label, request);
    }
    return;
  }
  if (type === 'dotli:polkavm-mediated-input-cancel') {
    if (
      data !== null &&
      Object.keys(data).every(key => key === 'type' || key === 'handle') &&
      Number.isInteger(data['handle']) &&
      Number(data['handle']) >= 1 &&
      Number(data['handle']) <= 0xffffffff
    ) {
      mediatedInputHost.cancel(source, Number(data['handle']));
    }
    return;
  }
  if (type === 'dotli:host-update-required') {
    window.dispatchEvent(new Event('dotli:host-update-required'));
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
  | Readonly<{ type: 'copy-text'; text: string }>
  | Readonly<{
      type: 'copy-image';
      width: number;
      height: number;
      rgba: Uint8Array;
    }>
  | Readonly<{ type: 'open-url'; url: string }>;

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

function validatedPolkaVmPlatformCommand(value: unknown): PolkaVmPlatformCommand | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const command = value as Record<string, unknown>;
  if (
    command['type'] === 'copy-text' &&
    Object.keys(command).every(key => key === 'type' || key === 'text') &&
    typeof command['text'] === 'string' &&
    polkavmPlatformEncoder.encode(command['text']).byteLength <= MAX_POLKAVM_COPY_TEXT_BYTES
  ) {
    return { type: 'copy-text', text: command['text'] };
  }
  if (
    command['type'] === 'copy-image' &&
    Object.keys(command).every(key => ['type', 'width', 'height', 'rgba'].includes(key)) &&
    Number.isInteger(command['width']) &&
    Number.isInteger(command['height']) &&
    Number(command['width']) > 0 &&
    Number(command['height']) > 0 &&
    Number(command['width']) <= MAX_POLKAVM_COPY_IMAGE_DIMENSION &&
    Number(command['height']) <= MAX_POLKAVM_COPY_IMAGE_DIMENSION &&
    Number(command['width']) * Number(command['height']) <= MAX_POLKAVM_COPY_IMAGE_PIXELS &&
    command['rgba'] instanceof Uint8Array &&
    command['rgba'].byteLength === Number(command['width']) * Number(command['height']) * 4
  ) {
    return {
      type: 'copy-image',
      width: Number(command['width']),
      height: Number(command['height']),
      rgba: command['rgba'],
    };
  }
  if (
    command['type'] === 'open-url' &&
    Object.keys(command).every(key => key === 'type' || key === 'url') &&
    typeof command['url'] === 'string' &&
    command['url'] !== '' &&
    polkavmPlatformEncoder.encode(command['url']).byteLength <= MAX_POLKAVM_OPEN_URL_BYTES
  ) {
    return {
      type: 'open-url',
      url: command['url'],
    };
  }
  return null;
}

function clipboardImagePng(command: Extract<PolkaVmPlatformCommand, { type: 'copy-image' }>): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = command.width;
  canvas.height = command.height;
  const context = canvas.getContext('2d');
  if (context === null) {
    return Promise.reject(new Error('2D canvas is unavailable'));
  }
  context.putImageData(new ImageData(new Uint8ClampedArray(command.rgba), command.width, command.height), 0, 0);
  const { promise, resolve, reject } = (
    Promise as PromiseConstructor & {
      withResolvers<T>(): {
        promise: Promise<T>;
        resolve: (value: T | PromiseLike<T>) => void;
        reject: (reason?: unknown) => void;
      };
    }
  ).withResolvers<Blob>();
  canvas.toBlob(blob => {
    if (blob === null) {
      reject(new Error('PNG encoding failed'));
    } else {
      resolve(blob);
    }
  }, 'image/png');
  return promise;
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: unknown; command?: unknown } | null;
  if (data?.type !== 'dotli:polkavm-user-activation' && data?.type !== 'dotli:polkavm-ui-command') {
    return;
  }
  const product = currentProduct;
  const source = currentHost?.iframe.contentWindow;
  if (
    product?.mode !== 'subdomain' ||
    event.origin !== sandboxOriginForLabel(product.label) ||
    source === null ||
    event.source !== source
  ) {
    return;
  }
  if (data.type === 'dotli:polkavm-user-activation') {
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
  if (command.type === 'copy-text') {
    void navigator.clipboard.writeText(command.text).catch((error: unknown) => {
      log.warn('[dot.li] PolkaVM clipboard request was declined:', error);
    });
    return;
  }
  if (command.type === 'copy-image') {
    try {
      const item = new ClipboardItem({
        'image/png': clipboardImagePng(command),
      });
      void navigator.clipboard.write([item]).catch((error: unknown) => {
        log.warn('[dot.li] PolkaVM image clipboard request was declined:', error);
      });
    } catch (error) {
      log.warn('[dot.li] PolkaVM image clipboard is unavailable:', error);
    }
    return;
  }
  let destination: URL;
  try {
    destination = new URL(command.url);
  } catch {
    return;
  }
  if (destination.protocol !== 'https:') {
    return;
  }
  window.open(destination.href, '_blank', 'noopener,noreferrer');
});

let bridgeEventListenersInitialized = false;

export function initBridgeEventListeners(modalCoordinator: BlockingModalCoordinator): void {
  if (bridgeEventListenersInitialized) {
    return;
  }
  initPageCore(modalCoordinator);
  blockingModalCoordinator = modalCoordinator;
  bridgeEventListenersInitialized = true;
  (window as typeof window & { __dotliTruapiBridgeReady?: boolean }).__dotliTruapiBridgeReady = true;
  if (DEBUG) {
    installProfileDebugTrigger();
    window.addEventListener('storage', event => {
      if (event.key === LOCAL_WALLET_ENABLED_KEY || event.key === LOCAL_WALLET_REVISION_KEY || event.key === null) {
        disposePageCores();
        window.location.reload();
      }
    });
    void initializeLocalWalletState().then(
      () => {
        if (isExperimentalWalletActive()) {
          void activeLocalWallet().catch(noop);
        }
      },
      (error: unknown) => {
        if (isExperimentalWalletActive()) {
          dispatchAuthState({
            tag: 'WalletUnavailable',
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
  }
  window.addEventListener('dotli:truapi-disconnect-request', () => {
    if (isExperimentalWalletActive()) {
      void experimentalWalletControls.disconnect();
      return;
    }
    void disconnectSession();
  });

  // User closed the pairing modal: the page's core runs every pairing,
  // whether the product or the topbar asked for it.
  window.addEventListener('dotli:truapi-cancel-login', () => {
    cancelPairing();
  });

  window.addEventListener('dotli:truapi-login-request', (event: Event) => {
    const detail = (event as CustomEvent<{ reason?: string }>).detail;
    void topbarLogin(detail.reason).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // A `LoginRequestError` came back over the wire, so the core already
      // rendered its own `LoginFailed` (or deliberately stayed silent, e.g.
      // a second login while one is pairing). Synthesize a state only for
      // failures the core never saw: host boot, encode, transport errors.
      if (!(error instanceof LoginRequestError)) {
        dispatchAuthState({
          tag: 'LoginFailed',
          kind: 'Other',
          reason: message,
        });
      }
    });
  });
}

/**
 * Log in from the topbar, over a connection of its own: the product's
 * connection forwards every frame to the product. The lease keeps the core
 * up until the login settles, whatever renders meanwhile.
 */
async function topbarLogin(reason: string | undefined): Promise<void> {
  const lease = await acquireCore();
  try {
    const core = wrapCoreProviderForDebug(await lease.connect());
    try {
      await requestCoreLogin(core, reason);
    } finally {
      core.dispose();
    }
  } finally {
    lease.release();
  }
}

async function disconnectSession(): Promise<void> {
  try {
    await revokeReceivingOnLogout();
  } catch (error) {
    showNotification({
      label: 'Background receiving',
      text: `Disconnect stopped: local receiving revocation failed. ${String(error)}`,
      browserNotification: false,
    });
    return;
  }
  let lease;
  try {
    lease = await acquireCore();
  } catch {
    // If the core cannot boot, keep the UI responsive even though persisted
    // core session state could not be cleared.
    dispatchAuthState({ tag: 'Disconnected' });
    return;
  }
  try {
    await lease.runtime.disconnectSession();
  } catch (err) {
    log.warn('[dot.li] disconnect failed:', err);
  } finally {
    lease.release();
  }
}

/**
 * Capture the deep link path, meaning pathname, search and hash, to forward
 * into the iframe.
 */
function getDeepPath(): string {
  const { pathname, search, hash } = window.location;
  let p = pathname;
  const base = import.meta.env.BASE_URL;
  if (base !== '/' && p.startsWith(base)) {
    p = '/' + p.slice(base.length);
  }
  const isRoot = p === '' || p === '/';
  if (isRoot) {
    return search || hash ? search + hash : '';
  }
  return p + search + hash;
}

/**
 * Pin the product iframe to the area the host chrome and the insets leave.
 * product-frame-layout owns its geometry from here on.
 */
function applyIframeStyling(iframe: HTMLIFrameElement): void {
  attachProductFrame(iframe);
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
}

function pipeProviders(
  product: Provider,
  core: Provider,
  args: { flowId: string; label: string; productId: string },
): () => void {
  let sawInbound = false;
  let sawOutbound = false;
  const unsubs = [
    product.subscribe(message => {
      if (inspectorRequestId(message) !== null) {
        return;
      }
      if (!sawInbound) {
        sawInbound = true;
        emitDotliDebugEvent({
          layer: 'bridge',
          event: 'first_inbound',
          flowId: args.flowId,
          timestamp: Date.now(),
          payload: { label: args.label, productId: args.productId },
        });
      }
      core.postMessage(message);
    }),
    core.subscribe(message => {
      if (inspectorRequestId(message) !== null) {
        return;
      }
      if (!sawOutbound) {
        sawOutbound = true;
        emitDotliDebugEvent({
          layer: 'bridge',
          event: 'first_outbound',
          flowId: args.flowId,
          timestamp: Date.now(),
          payload: { label: args.label, productId: args.productId },
        });
        window.dispatchEvent(new Event('dotli:debug:bridge-ready'));
      }
      product.postMessage(message);
    }),
    product.subscribeClose?.(() => {
      core.dispose();
    }),
    core.subscribeClose?.(() => {
      product.dispose();
    }),
  ].filter((fn): fn is () => void => typeof fn === 'function');

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

function emitWireFrameDebug(direction: 'incoming' | 'outgoing', productId: string, message: Uint8Array): void {
  if (!hasDotliDebugListeners()) {
    return;
  }
  try {
    const decoded = decodeWireMessage(message);
    if (decoded.isErr()) {
      return;
    }
    emitDotliDebugEvent({
      kind: 'truapi',
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

function wrapCoreProviderForDebug(connection: CoreConnection): CoreProviderBase {
  const { provider, productId } = connection;
  const listeners = new Set<(message: Uint8Array) => void>();
  let disposed = false;
  const unsubscribeCore = provider.subscribe(message => {
    if (disposed) {
      return;
    }
    emitWireFrameDebug('outgoing', productId, message);
    for (const listener of [...listeners]) {
      listener(message);
    }
  });

  return {
    postMessage(message: Uint8Array): void {
      if (disposed) {
        return;
      }
      emitWireFrameDebug('incoming', productId, message);
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
      connection.close();
    },
  };
}

let topbarLoginRequestSeq = 0;

export function requestCoreLogin(core: Provider, reason?: string): Promise<LoginResponse> {
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
        tag: 'V1',
        value: reason === undefined ? {} : { reason },
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
      core.subscribe(message => {
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
          rejectRequest(error instanceof Error ? error : new Error(String(error)));
        }
      }),
      unsubscribe => {
        unsubscribeMessage = unsubscribe;
      },
    );

    registerCleanup(
      core.subscribeClose?.(error => {
        rejectRequest(error);
      }),
      unsubscribe => {
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
  archiveCid?: string;
  productId?: string | undefined;
  container: HTMLElement;
  extraAllow?: readonly string[];
  debugFlowId: string;
  viewInsetsRelay?: boolean;
  /** How the product's avatar surface maps onto the frame. */
  avatarSurface?: AvatarSurfaceFit;
}): Promise<ActiveHost> {
  const hostGeneration = renderGeneration;
  const lease = await acquireCore();
  const contactAvatars = createContactAvatars();
  const contactLabels = createContactLabelOverlay();
  let connection: CoreConnection;
  let chatCapable: boolean;
  try {
    // Chat-capable products get a Worker-kind execution so the core serves
    // their chat calls; everything an App connection can do still works.
    // The capability is primed by the host shell before rendering, so
    // this await settles from cache or the in-flight manifest read.
    chatCapable = await chatCapabilityFor(args.label);
    connection = await lease.connect(chatCapable ? 'Worker' : 'App', {
      contactAvatars,
      contactLabels,
      archiveCid: args.archiveCid,
      isCurrentExecution: () => hostGeneration === renderGeneration,
    });
  } catch (error) {
    contactAvatars.dispose();
    contactLabels.dispose();
    lease.release();
    throw error;
  }
  const coreProvider = wrapCoreProviderForDebug(connection);
  const unregisterChat = chatCapable ? registerProductChat(connection, args.archiveCid) : noop;
  const unregisterPermissions = registerPermissionAuthorizationProvider(args.label, coreProvider);
  let productProvider: Provider | null = null;
  let disposePipe: (() => void) | null = null;
  let productProbeCleanup: (() => void) | null = null;
  let disposeViewInsets: (() => void) | null = null;
  let receivingPortConnected = false;
  const pipeArgs = {
    flowId: args.debugFlowId,
    label: args.label,
    productId: connection.productId,
  };
  const cleanupProductSide = (): void => {
    disposePipe?.();
    productProvider?.dispose();
    disposePipe = null;
    productProvider = null;
  };
  const connectProductPort = (port: MessagePort): void => {
    if (hostGeneration !== renderGeneration) {
      connection.receiving.close();
      port.close();
      return;
    }
    if (receivingPortConnected) {
      connection.receiving.close();
    }
    cleanupProductSide();
    // A new port is a restarted product: what it placed before is stale.
    contactAvatars.clear();
    contactLabels.clear();
    productProvider = createMessagePortProvider(port);
    disposePipe = pipeProviders(productProvider, coreProvider, pipeArgs);
    if (!receivingPortConnected) {
      connection.receiving.ready();
    }
    receivingPortConnected = true;
  };
  const cleanupCoreSide = (): void => {
    unregisterPermissions();
    unregisterChat();
    cleanupProductSide();
    coreProvider.dispose();
    contactAvatars.dispose();
    contactLabels.dispose();
    lease.release();
  };
  try {
    const allow = [
      await buildAllowAttribute(args.label, args.allowedOrigin),
      ...(args.extraAllow ?? []),
      'cross-origin-isolated',
    ].join('; ');
    const host = createIframeHost({
      iframeUrl: args.iframeUrl,
      allowedOrigin: args.allowedOrigin,
      allow,
      sandbox: args.sandbox,
      container: args.container,
      onPort: connectProductPort,
    });
    contactAvatars.attach(host.iframe, args.avatarSurface ?? 'viewport');
    contactLabels.attach(host.iframe, args.avatarSurface ?? 'viewport');
    if (args.viewInsetsRelay === true) {
      disposeViewInsets = installPolkaVmViewInsetsRelay(host.iframe, args.allowedOrigin);
    }

    // Codec-1 Nova products post raw SCALE frames to window.parent. Those
    // bytes have no codec marker and must never reach the codec-2 decoder.
    // Only the modern SDK's transferred MessagePort is supported.
    let probeMode: 'pending' | 'modern' = 'pending';
    let warnedLegacyTransport = false;
    const onProbe = (event: MessageEvent): void => {
      const targetWindow = host.iframe.contentWindow;
      if (!targetWindow || event.source !== targetWindow || event.origin !== args.allowedOrigin) {
        return;
      }
      if ((event.data as { type?: unknown } | null)?.type === 'truapi-ready') {
        if (probeMode === 'modern') {
          const channel = new MessageChannel();
          connectProductPort(channel.port1);
          targetWindow.postMessage({ type: 'truapi-init' }, args.allowedOrigin, [channel.port2]);
        } else {
          probeMode = 'modern';
        }
        return;
      }
      if (event.data instanceof Uint8Array && !warnedLegacyTransport) {
        warnedLegacyTransport = true;
        showNotification({
          text: 'This product uses the unsupported legacy Nova host API. Update it to @parity/truapi 0.16 or newer with the MessagePort transport.',
          label: 'Product update required',
          browserNotification: false,
        });
      }
    };
    window.addEventListener('message', onProbe);
    productProbeCleanup = () => {
      window.removeEventListener('message', onProbe);
      productProbeCleanup = null;
    };
    return {
      core: coreProvider,
      wallet: connection.wallet,
      generation: hostGeneration,
      receiving: connection.receiving,
      iframe: host.iframe,
      dispose() {
        mediatedInputHost.stop();
        disposeViewInsets?.();
        productProbeCleanup?.();
        cleanupCoreSide();
        host.dispose();
      },
    };
  } catch (error) {
    disposeViewInsets?.();
    productProbeCleanup?.();
    cleanupCoreSide();
    throw error;
  }
}

function registerProductChat({ provider, productId }: CoreConnection, archiveCid?: string): () => void {
  return registerChatConnection(productId, {
    loadRendererImage: createRendererImageLoader(archiveCid),
    publish: action =>
      provider.publishChatAction === undefined
        ? Promise.reject(new Error('chat publishing unavailable'))
        : provider.publishChatAction(action),
    publishRendererAction: item =>
      provider.publishRendererAction === undefined
        ? Promise.reject(new Error('renderer actions unavailable'))
        : provider.publishRendererAction(item),
    render: (request, sink) => {
      if (provider.render === undefined) {
        sink.onError?.(new Error('rendering unavailable'));
        return noop;
      }
      return provider.render(request, sink);
    },
  });
}

/**
 * Render a dApp iframe backed by the TrUAPI host bridge.
 */
export async function renderIframe(
  url: string,
  label: string,
  options: { productId?: string | undefined } = {},
): Promise<void> {
  const myRenderGeneration = ++renderGeneration;
  currentHost?.receiving.close();
  const renderFlowId = newFlowId('render');
  const bridgeFlowId = newFlowId('bridge');
  const productId = options.productId ?? label;
  emitDotliDebugEvent({
    layer: 'render',
    event: 'iframe_begin',
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, url, mode: 'iframe' },
  });
  const stopSetup = m.timer(S.BRIDGE_SETUP);
  // Keep the current product visible while its replacement frame connects.
  // A core booting for it can take several seconds. Removing the old iframe
  // first made permission-triggered reloads look like a permanently blank
  // application.
  const previousHost = currentHost;
  if (previousHost === null) {
    // This path has no loading overlay to keep, so the tracked roots go first
    // and whatever else the page left in `#app` goes with them.
    disposeAppRoots();
    app.innerHTML = '';
  }
  setPageProduct({ label, productId: options.productId });

  currentProduct = {
    mode: 'iframe',
    label,
    url,
    productId: options.productId,
  };

  const iframeUrl = new URL(url, window.location.href);
  emitDotliDebugEvent({
    layer: 'bridge',
    event: 'setup_begin',
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId },
  });
  const host = await createHost({
    iframeUrl: iframeUrl.href,
    allowedOrigin: iframeUrl.origin,
    // Keep parity with the current dotli product sandbox permissions.
    sandbox: 'allow-scripts allow-same-origin allow-forms allow-pointer-lock',
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
    layer: 'bridge',
    event: 'setup_ready',
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId },
  });
  applyIframeStyling(host.iframe);
  activateHost(host, previousHost);
  host.iframe.addEventListener(
    'load',
    () => {
      emitDotliDebugEvent({
        layer: 'bridge',
        event: 'iframe_load',
        flowId: bridgeFlowId,
        timestamp: Date.now(),
        payload: { label, productId, mode: 'iframe' },
      });
    },
    { once: true },
  );

  if (import.meta.env.VITE_SANDBOX_CHECKER !== undefined) {
    currentPanelDispose = mountViolationPanel(host.iframe);
  }

  stopSetup();
  document.title = `${label} · dot.li`;

  // Carry the runtime productId so listeners key chat data the same way
  // storage does when the debug path overrides the label-derived id.
  setProductLoaded(label, options.productId ?? labelToProductId(label));
  emitDotliDebugEvent({
    layer: 'render',
    event: 'iframe_ready',
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, mode: 'iframe' },
  });
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Whether the executable is a PolkaVM App, and how its avatar surface lands on
 * the frame. The sandbox fills the frame with the PolkaVM surface; only a
 * framebuffer canvas is contain-fitted inside it, while Tri2D and WebGPU
 * canvases stretch over all of it. Web products place in CSS pixels.
 */
function executableSurface(value: string | null): {
  polkaVm: boolean;
  avatarSurface: AvatarSurfaceFit;
} {
  let manifest: unknown;
  try {
    manifest = value === null ? null : JSON.parse(value);
  } catch {
    manifest = null;
  }
  if (field(field(manifest, 'runtime'), 'kind') !== 'polkavm') {
    return { polkaVm: false, avatarSurface: 'viewport' };
  }
  const profile = field(field(field(manifest, 'capabilities'), 'graphics'), 'profile');
  return {
    polkaVm: true,
    avatarSurface: profile === 'framebuffer' ? 'contain' : 'fill',
  };
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
  currentHost?.receiving.close();
  const renderFlowId = newFlowId('render');
  const bridgeFlowId = newFlowId('bridge');
  const stopSetup = m.timer(S.BRIDGE_SETUP);
  // Permission changes rebuild this host so the iframe receives a refreshed
  // `allow` attribute. Keep the current product visible until its replacement
  // iframe is connected, just like the direct-iframe render path.
  const previousHost = currentHost;
  setPageProduct({ label });

  currentProduct = {
    mode: 'subdomain',
    label,
    cid,
    executableManifest,
  };

  // Propagate the current sandbox contract. The `?mode=` preset param is no
  // longer sent. Host and sandbox deploy together, and the sandbox validator
  // rejects unknown params.
  const chainBackend = getBackend();
  const network = getNetwork();
  const appOrigin = sandboxOriginForLabel(label);
  const deepPath = getDeepPath();
  // One-shot: the settings popover sets this flag right before reloading so
  // the first sandbox boot after "Save & Apply" wipes its own origin too.
  // Consume and clear so subsequent navigations (permission reload, etc.)
  // don't keep triggering resets.
  let fullReset = false;
  try {
    if (sessionStorage.getItem('dotli:pending-reset:sandbox') === '1') {
      fullReset = true;
      sessionStorage.removeItem('dotli:pending-reset:sandbox');
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
  parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.v, String(SANDBOX_SCHEMA_VERSION));
  parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.chainBackend, chainBackend);
  parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.network, network);
  parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.polkaVmEnabled, getPolkaVmAppsEnabled(SITE_ID) ? '1' : '0');
  if (executableManifest !== null) {
    parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.executableManifest, executableManifest);
  }
  if (fullReset) {
    parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.fullReset, '1');
  }
  const resolutionId = getResolutionId();
  if (resolutionId !== null) {
    parsedUrl.searchParams.set(SANDBOX_CONTRACT_PARAMS.resolutionId, resolutionId);
  }
  const url = parsedUrl.toString();

  // Keep the loading overlay visible. The sandbox will post status
  // messages via dotli:loading-status and a final done=true to dismiss it.
  // Only on the initial render. During a permission refresh the current
  // iframe remains visible until the replacement is ready, and the overlay,
  // if still up, is disposed then.
  const keepLoading = previousHost === null;

  const iframeUrl = new URL(url);
  const surface = executableSurface(executableManifest);
  emitDotliDebugEvent({
    layer: 'bridge',
    event: 'setup_begin',
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId: label },
  });
  emitDotliDebugEvent({
    layer: 'render',
    event: 'iframe_begin',
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, url, mode: 'subdomain' },
  });
  const host = await createHost({
    // The CID comes from host resolution, never product postMessage data.
    iframeUrl: url,
    allowedOrigin: iframeUrl.origin,
    sandbox: 'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups',
    label,
    archiveCid: cid,
    extraAllow: surface.polkaVm ? ['accelerometer', 'gyroscope'] : [],
    viewInsetsRelay: surface.polkaVm,
    avatarSurface: surface.avatarSurface,
    container: app,
    debugFlowId: bridgeFlowId,
  });
  if (myRenderGeneration !== renderGeneration) {
    host.dispose();
    stopSetup();
    return;
  }
  emitDotliDebugEvent({
    layer: 'bridge',
    event: 'setup_ready',
    flowId: bridgeFlowId,
    timestamp: Date.now(),
    payload: { label, productId: label },
  });
  applyIframeStyling(host.iframe);
  activateHost(host, previousHost, keepLoading);
  host.iframe.addEventListener(
    'load',
    () => {
      emitDotliDebugEvent({
        layer: 'bridge',
        event: 'iframe_load',
        flowId: bridgeFlowId,
        timestamp: Date.now(),
        payload: { label, productId: label, mode: 'subdomain' },
      });
    },
    { once: true },
  );

  if (import.meta.env.VITE_SANDBOX_CHECKER !== undefined) {
    currentPanelDispose = mountViolationPanel(host.iframe);
  }

  stopSetup();
  document.title = withActiveTld(label);

  setProductLoaded(label, labelToProductId(label), cid);
  emitDotliDebugEvent({
    layer: 'render',
    event: 'iframe_ready',
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, mode: 'subdomain' },
  });
}

function activateHost(host: ActiveHost, previousHost: ActiveHost | null, keepLoading = false): void {
  stopMotionRelay();
  mediatedInputHost.stop();
  if (currentPanelDispose) {
    currentPanelDispose();
    currentPanelDispose = null;
  }
  // The previous frame leaves with its host.
  previousHost?.dispose();
  disposeAppRoot('page');
  if (!keepLoading) {
    disposeAppRoot('loading');
  }
  // The one untracked child: an error page written over a product whose frame
  // was already up (a failure after `activateHost`), which a later rebuild of
  // that product has to clear.
  for (const stray of app.querySelectorAll(':scope > .error-page')) {
    stray.remove();
  }
  currentHost = host;
  const product = currentProduct;
  if (product?.mode === 'subdomain') {
    const generation = renderGeneration;
    const unregister = registerProductNotificationTarget(product.label, {
      artifact: product.cid,
      entryUrl: new URL('/', window.location.origin).href,
      isActive: () => currentHost === host && renderGeneration === generation,
      focus: () => {
        window.focus();
        host.iframe.contentWindow?.focus();
      },
    });
    const dispose = host.dispose;
    host.dispose = () => {
      unregister();
      dispose();
    };
  }
}

function newFlowId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${prefix}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
}
