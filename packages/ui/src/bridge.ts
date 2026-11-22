// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Connects the page's TrUAPI core to the product iframe and to the topbar's login and logout. Nested
// products are not modeled separately, so any nested traffic must share the top-level core.

import {
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
import { buildAllowAttribute, registerPermissionAuthorizationProvider, setPermissionStatus } from './permissions.js';
import { dispatchAuthState } from './host-callbacks/AuthState.js';
import { LoginRequestError } from './login-request-error.js';
import { attachProductFrame } from './product-frame-layout.js';
import { labelToProductId } from './runtime-config.js';
import {
  acquireCore,
  cancelPairing,
  initPageCore,
  setPageProduct,
  type CoreConnection,
  type CoreLease,
} from './page-core.js';

export { setPageProduct } from './page-core.js';
// The pool behind these leases already ships in this chunk, so other callers take them from here.
export { hostAssetHubProvider, hostChainProvider } from './host-callbacks/Chain.js';
import { setProductLoaded } from './state/product.js';
import { getWalletMode } from './state/wallet-mode.js';
import { reportLocalWalletFailure } from './wallet-boot.js';
import { switchToPolkadotApp } from './wallet-switch.js';
import { describeWireFrame } from './debug-wire-describe.js';
import { throwIfAborted, type BlockingModalCoordinator } from './blocking-modal-queue.js';
import { createRendererImageLoader, registerChatConnection } from './chat/service.js';
import { showNotification } from './notification.js';
import { registerProductNotificationTarget } from './notification-activation.js';
import { ERRORS } from './errors.js';
import { disposeAppRoot, disposeAppRoots } from './mount/app-roots.js';
import { CameraInputCancelledError, CameraInputPermissionError, scanCameraUr } from './mediated-input-camera.js';
import { MediatedInputHost, validatedMediatedInputRequest } from './mediated-input-host.js';
import { decidePromptPermission } from './host-callbacks/PromptPermission.js';
import { createSubmitRateLimiter } from './host-callbacks/rate-limit.js';
import { installPolkaVmViewInsetsRelay } from './polkavm-view-insets.js';
import { createMediaHost, mediaOwnsCapture, PROTECTED_MEDIA_ALLOW, PROTECTED_MEDIA_SANDBOX } from './media-host.js';

const noop = (): void => undefined;

// Preloaded so they are ready when the first product renders.
const chunkLoadStart = performance.now();
const runtimeChunkPromise = Promise.all([
  import('@parity/truapi-host/web'),
  import('@parity/truapi-host/worker-runtime?worker'),
]).then(([web]) => {
  m.measure(S.BRIDGE_CHUNK_LOAD, performance.now() - chunkLoadStart);
  return { createIframeHost: web.createIframeHost };
});
void runtimeChunkPromise.catch(() => {
  // The render that awaits it reports the failure.
});

const app = document.getElementById('app') ?? document.body;

interface ActiveHost {
  iframe: HTMLIFrameElement;
  /** End host-owned calls now, before a replacement render settles. */
  stopMedia: () => void;
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
      legacyCapture: boolean;
    }
  | {
      mode: 'subdomain';
      label: string;
      cid: string;
      executableManifest: string | null;
      legacyCapture: boolean;
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
      throwIfAborted(signal);
      // This host-mediated capture has no pending Rust permission callback to commit its answer.
      if (decision !== 'AllowOnce') {
        await setPermissionStatus(label, 'Camera', decision === 'AllowAlways' ? 'granted' : 'denied');
      }
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

function rerenderProduct(product: CurrentProduct): void {
  const expectedGeneration = renderGeneration + 1;
  const render =
    product.mode === 'iframe'
      ? renderIframe(product.url, product.label, {
          productId: product.productId,
          legacyCapture: product.legacyCapture,
        })
      : renderAppSubdomain(product.cid, product.label, product.executableManifest, {
          legacyCapture: product.legacyCapture,
        });
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

// Listen for device permission grants. Reload the iframe so the updated
// `allow` attribute takes effect. Keep the current iframe visible and surface
// a retry if replacement host startup fails.
window.addEventListener('dotli:device-permission-changed', event => {
  const product = currentProduct;
  const permission = (event as CustomEvent<{ permission?: unknown } | null>).detail?.permission;
  // A protected Media container denies raw camera and microphone in its
  // `allow` attribute whatever the grant, so those changes need no reload.
  if (
    product !== null &&
    !(mediaOwnsCapture(product.label) && (permission === 'Camera' || permission === 'Microphone'))
  ) {
    rerenderProduct(product);
  }
});

// The trusted permissions menu switches this execution between the protected
// host Media container and legacy raw product capture.
window.addEventListener('dotli:capture-container-changed', event => {
  const detail = (event as CustomEvent<{ label?: unknown; legacyCapture?: unknown } | null>).detail;
  const product = currentProduct;
  if (product === null || detail?.label !== product.label || typeof detail.legacyCapture !== 'boolean') {
    return;
  }
  // Calls and raw capture end before the replacement container exists.
  currentHost?.dispose();
  currentHost = null;
  rerenderProduct({ ...product, legacyCapture: detail.legacyCapture });
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
  window.addEventListener('dotli:truapi-disconnect-request', () => {
    log.event('logout requested', { flow: 'wallet' });
    if (getWalletMode() === 'local') {
      // A local session lives only in memory, so logging out means leaving local mode.
      switchToPolkadotApp().catch((error: unknown) => {
        reportLocalWalletFailure(error, 'forget');
      });
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

/**
 * Pin the product iframe to the area the host chrome and the insets leave.
 * product-frame-layout owns its geometry from here on. A protected Media
 * container positions its trusted compositor, which the iframe fills.
 */
function applyIframeStyling(iframe: HTMLIFrameElement): void {
  const parent = iframe.parentElement;
  attachProductFrame(iframe, parent?.classList.contains('host-media-compositor') === true ? parent : iframe);
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
      payload: describeWireFrame(decoded.value.payload, decoded.value.payload.value, {
        decodeWalletFrames: getWalletMode() === 'local',
      }),
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
    async setPermissionAuthorizationStatus(request, status) {
      await provider.setPermissionAuthorizationStatus(request, status);
      // Report the decision only once every live core sharing it applied it.
      await connection.waitForPermissionRefresh(request);
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
  /** Cross-origin product origin of a protected Media container. */
  mediaOrigin?: string;
}): Promise<ActiveHost> {
  const coordinator = blockingModalCoordinator;
  const media =
    args.mediaOrigin !== undefined && coordinator !== null
      ? createMediaHost({
          label: args.label,
          productId: args.productId ?? labelToProductId(args.label),
          origin: args.mediaOrigin,
          coordinator,
        })
      : undefined;
  // The trusted compositor is the product frame's immediate, isolated parent;
  // host media planes sit beside the frame inside it.
  const container = media === undefined ? args.container : document.createElement('div');
  if (media !== undefined) {
    container.className = 'host-media-compositor';
    container.style.cssText = 'position:fixed;isolation:isolate;z-index:0;overflow:hidden;';
    args.container.append(container);
  }
  const disposeMedia = (): void => {
    media?.dispose();
    if (media !== undefined) {
      container.remove();
    }
  };
  let lease: CoreLease;
  try {
    lease = await acquireCore();
  } catch (error) {
    disposeMedia();
    throw error;
  }
  let connection: CoreConnection;
  let chatCapable: boolean;
  try {
    // A Worker-kind execution gets chat calls served on top of everything an App connection can do.
    chatCapable = await chatCapabilityFor(args.label);
    log.event('chat capability resolved', { flow: 'chat', capable: chatCapable });
    connection = await lease.connect(chatCapable ? 'Worker' : 'App', media);
    log.event('product connected to wallet core', { flow: 'wallet', kind: chatCapable ? 'Worker' : 'App' });
  } catch (error) {
    disposeMedia();
    lease.release();
    throw error;
  }
  let coreProvider: CoreProviderBase | null = wrapCoreProviderForDebug(connection);
  media?.bindProvider(coreProvider);
  let unregisterChat = chatCapable ? registerProductChat(connection, args.archiveCid) : noop;
  let unregisterPermissions = registerPermissionAuthorizationProvider(args.label, coreProvider);
  let executionGeneration = 0;
  let disposed = false;
  let hasProductPort = false;
  let pendingPort: MessagePort | null = null;
  let connecting = false;
  const { createIframeHost } = await runtimeChunkPromise;
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
      .connect(chatCapable ? 'Worker' : 'App', media)
      .then(next => {
        if (disposed || generation !== executionGeneration) {
          next.close();
          port.close();
          return;
        }
        connection = next;
        try {
          coreProvider = wrapCoreProviderForDebug(next);
          media?.bindProvider(coreProvider);
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
    disposeMedia();
    lease.release();
  };
  try {
    const granted = await buildAllowAttribute(args.label);
    // A protected container never receives raw capture, whatever was granted.
    const productAllow =
      media === undefined
        ? granted
        : [
            ...granted.split('; ').filter(directive => directive !== 'camera' && directive !== 'microphone'),
            PROTECTED_MEDIA_ALLOW,
          ].join('; ');
    const allow = [productAllow, ...(args.extraAllow ?? []), 'cross-origin-isolated'].join('; ');
    const host = createIframeHost({
      iframeUrl: args.iframeUrl,
      allowedOrigin: args.allowedOrigin,
      allow,
      sandbox: args.sandbox,
      container,
      onPort: connectProductPort,
    });
    if (media !== undefined) {
      host.iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;z-index:1;';
      media.attach(host.iframe, container);
    }
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
          // A second handshake means the product document was replaced.
          media?.dispose();
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
      iframe: host.iframe,
      stopMedia() {
        media?.dispose();
      },
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
  options: { productId?: string | undefined; legacyCapture?: boolean } = {},
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
  // Keep the current product visible while its replacement frame connects.
  // A core booting for it can take several seconds. Removing the old iframe
  // first made permission-triggered reloads look like a permanently blank
  // application.
  const previousHost = retirePreviousMedia(options.legacyCapture === true);
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
    legacyCapture: options.legacyCapture === true,
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
    sandbox:
      options.legacyCapture === true
        ? // Keep parity with the current dotli product sandbox permissions.
          'allow-scripts allow-same-origin allow-forms allow-pointer-lock'
        : PROTECTED_MEDIA_SANDBOX,
    label,
    productId: options.productId,
    container: app,
    debugFlowId: bridgeFlowId,
    // Same-origin frames cannot be isolated from the host's Media.
    ...(options.legacyCapture !== true && iframeUrl.origin !== location.origin
      ? { mediaOrigin: iframeUrl.origin }
      : {}),
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
    const { mountViolationPanel } = await import('./components/sandbox-checker/mount.js');
    if (myRenderGeneration !== renderGeneration) {
      stopSetup();
      return;
    }
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

/**
 * End the current product's host Media before its replacement renders. A
 * legacy raw-capture frame is removed at once when protected Media replaces
 * it. Returns the host to keep visible until the replacement is ready.
 */
function retirePreviousMedia(legacyCapture: boolean): ActiveHost | null {
  const previous = currentHost;
  previous?.stopMedia();
  if (previous !== null && currentProduct?.legacyCapture === true && !legacyCapture) {
    previous.dispose();
    currentHost = null;
    return null;
  }
  return previous;
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
  options: { legacyCapture?: boolean } = {},
): Promise<void> {
  const myRenderGeneration = ++renderGeneration;
  const renderFlowId = newFlowId('render');
  const bridgeFlowId = newFlowId('bridge');
  const stopSetup = m.timer(S.BRIDGE_SETUP);
  // Permission changes rebuild this host so the iframe receives a refreshed
  // `allow` attribute. Keep the current product visible until its replacement
  // iframe is connected, just like the direct-iframe render path.
  const previousHost = retirePreviousMedia(options.legacyCapture === true);
  setPageProduct({ label });

  currentProduct = {
    mode: 'subdomain',
    label,
    cid,
    executableManifest,
    legacyCapture: options.legacyCapture === true,
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
    sandbox:
      options.legacyCapture === true
        ? 'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups'
        : PROTECTED_MEDIA_SANDBOX,
    label,
    archiveCid: cid,
    extraAllow: isPolkaVm ? ['accelerometer', 'gyroscope'] : [],
    viewInsetsRelay: isPolkaVm,
    container: app,
    debugFlowId: bridgeFlowId,
    ...(options.legacyCapture === true ? {} : { mediaOrigin: appOrigin }),
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
    const { mountViolationPanel } = await import('./components/sandbox-checker/mount.js');
    if (myRenderGeneration !== renderGeneration) {
      stopSetup();
      return;
    }
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
