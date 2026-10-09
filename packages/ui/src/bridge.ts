// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Connects the page's TrUAPI core to the product iframe and to the topbar's login and logout. Nested
// products are not modeled separately, so any nested traffic must share the top-level core.

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

import { captureException, getResolutionId, m, recordExpected, spans as S } from '@dotli/metrics';
import { chatCapabilityFor, log } from '@dotli/shared';

import { emitDotliDebugEvent, hasDotliDebugListeners } from '@dotli/truapi-debug';
import type { TrUApiProductProvider } from '@parity/truapi-host';
import { createIframeHost } from '@parity/truapi-host/web';
import { buildAllowAttribute, registerPermissionAuthorizationProvider } from './permissions.js';
import { dispatchAuthState } from './host-callbacks/AuthState.js';
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
// The pool behind these leases already ships in this chunk, so other callers take them from here.
export { hostAssetHubProvider, hostChainProvider } from './host-callbacks/Chain.js';
import { setProductLoaded } from './state/product.js';
import { describeWireFrame } from './debug-wire-describe.js';
import type { BlockingModalCoordinator } from './blocking-modal-queue.js';
import { createRendererImageLoader, registerChatConnection } from './chat/service.js';
import { showNotification } from './notification.js';
import { registerProductNotificationTarget } from './notification-activation.js';
import { ERRORS } from './errors.js';
import { disposeAppRoot, disposeAppRoots } from './mount/app-roots.js';
import { mountViolationPanel } from './components/sandbox-checker/mount.js';
import { CameraInputCancelledError, CameraInputPermissionError, scanCameraUr } from './mediated-input-camera.js';
import { MediatedInputHost, validatedMediatedInputRequest } from './mediated-input-host.js';
import { decidePromptPermission } from './host-callbacks/PromptPermission.js';
import { createSubmitRateLimiter } from './host-callbacks/rate-limit.js';
import { installPolkaVmViewInsetsRelay } from './polkavm-view-insets.js';

const noop = (): void => undefined;

const app = document.getElementById('app') ?? document.body;

interface ActiveHost {
  core: CoreProviderBase;
  wallet: LiveLocalWallet | undefined;
  generation: number;
  iframe: HTMLIFrameElement;
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
  const core = host.core;
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
      if (currentProduct !== product || currentHost !== host || generation !== renderGeneration || host.core !== core) {
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
    // A newer render owns the UI now.
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

// A new `allow` attribute only takes effect in a fresh iframe.
window.addEventListener('dotli:device-permission-changed', () => {
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
    log.event('logout requested', { flow: 'wallet' });
    if (isExperimentalWalletActive()) {
      void experimentalWalletControls.disconnect();
      return;
    }
    void disconnectSession();
  });

  window.addEventListener('dotli:truapi-cancel-login', () => {
    log.event('pairing cancelled', { flow: 'wallet' });
    cancelPairing();
  });

  window.addEventListener('dotli:truapi-login-request', (event: Event) => {
    const detail = (event as CustomEvent<{ reason?: string }>).detail;
    log.event('login requested', { flow: 'wallet' });
    void topbarLogin(detail.reason).then(
      () => {
        log.event('login completed', { flow: 'wallet' });
      },
      (error: unknown) => {
        reportLoginFailure(error);
        const message = error instanceof Error ? error.message : String(error);
        // The core already rendered a `LoginRequestError`, or stayed silent on purpose. Synthesize a
        // state only for failures it never saw.
        if (!(error instanceof LoginRequestError)) {
          dispatchAuthState({
            tag: 'LoginFailed',
            kind: 'Other',
            reason: message,
          });
        }
      },
    );
  });
}

/** A cancelled or denied login is an outcome, not a fault. The core's other refusals are still reported. */
function reportLoginFailure(error: unknown): void {
  if (error instanceof LoginRequestError && (error.error.tag === 'Cancelled' || error.error.tag === 'Denied')) {
    recordExpected(error, { flow: 'wallet', step: 'login' });
    return;
  }
  captureException(error, {
    flow: 'wallet',
    step: 'login',
    ...(error instanceof LoginRequestError ? { tags: { login_error: error.error.tag } } : {}),
  });
}

/** Over a connection of its own, since the product's connection forwards every frame to the product. */
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
  let lease;
  try {
    lease = await acquireCore();
  } catch (err) {
    // Keep the UI responsive even though the persisted session could not be cleared.
    log.warn('[dot.li] disconnect skipped, the wallet core did not boot:', err);
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
        // Teardown race.
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
    // Debug tap failures must not affect the transport.
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
}): Promise<ActiveHost> {
  const lease = await acquireCore();
  let connection: CoreConnection;
  let chatCapable: boolean;
  try {
    // A Worker-kind execution gets chat calls served on top of everything an App connection can do.
    chatCapable = await chatCapabilityFor(args.label);
    log.event('chat capability resolved', { flow: 'chat', capable: chatCapable });
    connection = await lease.connect(chatCapable ? 'Worker' : 'App');
    log.event('product connected to wallet core', { flow: 'wallet', kind: chatCapable ? 'Worker' : 'App' });
  } catch (error) {
    lease.release();
    throw error;
  }
  let coreProvider: CoreProviderBase | null = wrapCoreProviderForDebug(connection);
  let unregisterChat = chatCapable ? registerProductChat(connection, args.archiveCid) : noop;
  let unregisterPermissions = registerPermissionAuthorizationProvider(args.label, coreProvider);
  let executionGeneration = 0;
  let disposed = false;
  let hasProductPort = false;
  let pendingPort: MessagePort | null = null;
  let connecting = false;
  let productProvider: Provider | null = null;
  let disposePipe: (() => void) | null = null;
  let productProbeCleanup: (() => void) | null = null;
  let disposeViewInsets: (() => void) | null = null;
  // Whether the product has sent a frame on the current port, which proves
  // it adopted that port's `truapi-init`.
  let productPortUsed = false;
  let unsubscribeProductPortUse: (() => void) | null = null;
  const pipeArgs = {
    flowId: args.debugFlowId,
    label: args.label,
    productId: connection.productId,
  };
  const cleanupProductSide = (): void => {
    unsubscribeProductPortUse?.();
    unsubscribeProductPortUse = null;
    disposePipe?.();
    productProvider?.dispose();
    disposePipe = null;
    productProvider = null;
  };
  const bindProductPort = (port: MessagePort): void => {
    if (coreProvider === null) {
      throw new Error('The product execution is not connected.');
    }
    const provider = createMessagePortProvider(port);
    productProvider = provider;
    unsubscribeProductPortUse = provider.subscribe(() => {
      productPortUsed = true;
      unsubscribeProductPortUse?.();
      unsubscribeProductPortUse = null;
    });
    disposePipe = pipeProviders(provider, coreProvider, pipeArgs);
  };
  const retireExecution = (): void => {
    const previous = coreProvider;
    coreProvider = null;
    unregisterPermissions();
    unregisterPermissions = noop;
    unregisterChat();
    unregisterChat = noop;
    previous?.dispose();
  };
  const connectPendingPort = (): void => {
    const port = pendingPort;
    if (disposed || connecting || port === null) {
      return;
    }
    connecting = true;
    const generation = executionGeneration;
    void lease
      .connect(chatCapable ? 'Worker' : 'App')
      .then(next => {
        if (disposed || generation !== executionGeneration) {
          next.close();
          port.close();
          return;
        }
        connection = next;
        try {
          coreProvider = wrapCoreProviderForDebug(next);
          unregisterChat = chatCapable ? registerProductChat(next, args.archiveCid) : noop;
          unregisterPermissions = registerPermissionAuthorizationProvider(args.label, coreProvider);
          pendingPort = null;
          bindProductPort(port);
        } catch (error) {
          next.close();
          throw error;
        }
      })
      .catch((error: unknown) => {
        port.close();
        if (disposed || generation !== executionGeneration) {
          return;
        }
        cleanupCoreSide();
        log.error('[dot.li] Product execution reconnect failed:', error);
        showNotification({
          label: 'dot.li',
          text: 'The app could not reconnect to the host.',
          browserNotification: false,
          dismissMs: 0,
          action: {
            label: 'Reload',
            onClick: () => {
              window.location.reload();
            },
          },
        });
      })
      .finally(() => {
        connecting = false;
        // Coalesce documents replaced during startup without creating an
        // unbounded number of native executions. Failed current starts stop.
        connectPendingPort();
      });
  };
  const connectProductPort = (port: MessagePort): void => {
    if (disposed) {
      port.close();
      return;
    }
    cleanupProductSide();
    pendingPort?.close();
    pendingPort = null;
    productPortUsed = false;
    if (!hasProductPort) {
      hasProductPort = true;
      bindProductPort(port);
      return;
    }

    // A fresh document must not inherit prompts, one-use grants or resources
    // from its predecessor. Keep the wallet lease, but replace its execution.
    retireExecution();
    executionGeneration++;
    pendingPort = port;
    connectPendingPort();
  };
  const cleanupCoreSide = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    executionGeneration++;
    pendingPort?.close();
    pendingPort = null;
    cleanupProductSide();
    retireExecution();
    lease.release();
  };
  try {
    const allow = [await buildAllowAttribute(args.label), ...(args.extraAllow ?? []), 'cross-origin-isolated'].join(
      '; ',
    );
    const host = createIframeHost({
      iframeUrl: args.iframeUrl,
      allowedOrigin: args.allowedOrigin,
      allow,
      sandbox: args.sandbox,
      container: args.container,
      onPort: connectProductPort,
    });
    if (args.viewInsetsRelay === true) {
      disposeViewInsets = installPolkaVmViewInsetsRelay(host.iframe, args.allowedOrigin);
    }

    // Codec-1 Nova products post raw SCALE frames to window.parent. Those
    // bytes have no codec marker and must never reach the codec-2 decoder.
    // Only the modern SDK's transferred MessagePort is supported.
    let probeMode: 'pending' | 'modern' = 'pending';
    let probeConnectionId: string | null = null;
    let warnedLegacyTransport = false;
    const onProbe = (event: MessageEvent): void => {
      const targetWindow = host.iframe.contentWindow;
      if (!targetWindow || event.source !== targetWindow || event.origin !== args.allowedOrigin) {
        return;
      }
      const data: unknown = event.data;
      if (typeof data === 'object' && data !== null && 'type' in data && data.type === 'truapi-ready') {
        const connectionId = 'connectionId' in data ? data.connectionId : undefined;
        if (typeof connectionId === 'string') {
          // Ready is retried while the first port transfer is in flight. Replacing
          // that port strands the client, which accepts only the first transfer.
          if (connectionId === probeConnectionId) {
            return;
          }
          probeConnectionId = connectionId;
        } else {
          // Clients before @parity/truapi 0.23 retry ready without a
          // connectionId and also accept only the first transfer. Until the
          // product uses the current port, a repeat is a retry of that
          // handshake; afterwards it means a replaced product document.
          if (probeMode === 'modern' && probeConnectionId === null && !productPortUsed) {
            return;
          }
          probeConnectionId = null;
        }
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
      get core() {
        if (coreProvider === null) {
          throw new Error('The product execution is not connected.');
        }
        return coreProvider;
      },
      get wallet() {
        return connection.wallet;
      },
      generation: renderGeneration,
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

export async function renderIframe(
  url: string,
  label: string,
  options: { productId?: string | undefined } = {},
): Promise<void> {
  const myRenderGeneration = ++renderGeneration;
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
  // Keep the current product visible while its replacement connects, which can take seconds.
  const previousHost = currentHost;
  if (previousHost === null) {
    // This path has no loading overlay to keep.
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

  // The runtime productId, so chat data is keyed like storage when the debug path overrides it.
  setProductLoaded(label, options.productId ?? labelToProductId(label));
  emitDotliDebugEvent({
    layer: 'render',
    event: 'iframe_ready',
    flowId: renderFlowId,
    timestamp: Date.now(),
    payload: { label, mode: 'iframe' },
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
      typeof manifest !== 'object' ||
      !('runtime' in manifest) ||
      manifest.runtime === null ||
      typeof manifest.runtime !== 'object' ||
      !('kind' in manifest.runtime)
    ) {
      return false;
    }
    return manifest.runtime.kind === 'polkavm';
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
  const renderFlowId = newFlowId('render');
  const bridgeFlowId = newFlowId('bridge');
  const stopSetup = m.timer(S.BRIDGE_SETUP);
  // Keep the current product visible until its replacement connects.
  const previousHost = currentHost;
  setPageProduct({ label });

  currentProduct = {
    mode: 'subdomain',
    label,
    cid,
    executableManifest,
  };

  // The sandbox validator rejects unknown params.
  const chainBackend = getBackend();
  const network = getNetwork();
  const appOrigin = sandboxOriginForLabel(label);
  const deepPath = getDeepPath();
  // One-shot, so later navigations such as a permission reload do not reset again.
  let fullReset = false;
  try {
    if (sessionStorage.getItem('dotli:pending-reset:sandbox') === '1') {
      fullReset = true;
      sessionStorage.removeItem('dotli:pending-reset:sandbox');
    }
    // eslint-disable-next-line no-restricted-syntax -- sessionStorage may be unavailable in Safari private mode, so the reset flag defaults to false which is the safe state.
  } catch {
    // No pending reset.
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

  // On the initial render the sandbox dismisses the overlay itself, with `dotli:loading-status`.
  const keepLoading = previousHost === null;

  const iframeUrl = new URL(url);
  const isPolkaVm = isPolkaVmExecutableManifest(executableManifest);
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
    iframeUrl: url,
    allowedOrigin: iframeUrl.origin,
    sandbox: 'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups',
    label,
    archiveCid: cid,
    extraAllow: isPolkaVm ? ['accelerometer', 'gyroscope'] : [],
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
  previousHost?.dispose();
  disposeAppRoot('page');
  if (!keepLoading) {
    disposeAppRoot('loading');
  }
  // An error page written after an earlier `activateHost` is the one untracked child a rebuild must clear.
  for (const stray of app.querySelectorAll(':scope > [data-error-page]')) {
    stray.remove();
  }
  currentHost = host;
  const product = currentProduct;
  if (product !== null) {
    const generation = renderGeneration;
    const unregister = registerProductNotificationTarget(product.label, {
      // Direct frames have mutable, unverified content: activations belong to
      // this execution, not a later visit to the same URL.
      artifact: product.mode === 'subdomain' ? product.cid : `iframe:${crypto.randomUUID()}`,
      entryUrl: product.mode === 'subdomain' ? new URL('/', window.location.origin).href : window.location.href,
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
