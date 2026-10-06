// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  AuthState,
  CoreStorageKey,
  MediaPlatform,
  PermissionAuthorizationRequest,
  PermissionAuthorizationStatus,
  ProductContext,
  TrUApiProductProvider,
} from '@parity/truapi-host';
import { createBrowserMediaBackend, type BrowserMediaGeometry } from '@parity/truapi-host/web';
import {
  blockingModalAbortError,
  type BlockingModalCoordinator,
  type BlockingModalScope,
} from './blocking-modal-queue.js';
import { showPermissionRequestModal } from './permission-modal.js';

type CallingRequest = Extract<PermissionAuthorizationRequest, { tag: 'Calling' }>;
type PermissionProvider = Pick<
  TrUApiProductProvider,
  'getPermissionAuthorizationStatus' | 'setPermissionAuthorizationStatus'
>;

/**
 * Sandbox of a protected Media container. No popups or top navigation: a
 * popup would be a top-level document outside the frame's capture denials.
 */
export const PROTECTED_MEDIA_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-pointer-lock';

/** Permissions Policy denials appended to a protected container's `allow`. */
export const PROTECTED_MEDIA_ALLOW =
  "camera 'none'; microphone 'none'; display-capture 'none'; fullscreen 'none'; picture-in-picture 'none'";

/** Pure translations stay representable; any scale, rotation or skew blanks media. */
const TRANSLATION = /^matrix\(1, 0, 0, 1, -?[\d.e+-]+, -?[\d.e+-]+\)$/;

export interface CallingPermissionSetting {
  productId: string;
  network: string;
  account: string;
  status: PermissionAuthorizationStatus;
  revoke(): Promise<void>;
}

export interface BrowserMediaHost {
  platform: Required<MediaPlatform>;
  bindProvider(provider: PermissionProvider): void;
  observeStorage(key: CoreStorageKey): void;
  authChanged(state: AuthState): void;
  attach(frame: HTMLIFrameElement, mount: HTMLElement): void;
  callingSettings(): Promise<CallingPermissionSetting[]>;
  dispose(): void;
}
const mediaHosts = new Map<string, Set<BrowserMediaHost>>();

export function mediaOwnsCapture(label: string): boolean {
  return (mediaHosts.get(label)?.size ?? 0) > 0;
}

export async function callingPermissionSettings(label: string): Promise<CallingPermissionSetting[]> {
  const hosts = [...(mediaHosts.get(label) ?? [])];
  return (await Promise.all(hosts.map(host => host.callingSettings()))).flat();
}

/** Host-only adapter for an authenticated, cross-origin product execution. */
export function createMediaHost(options: {
  label: string;
  productId: string;
  origin: string;
  coordinator: BlockingModalCoordinator;
  /** Supplied only by trusted host facilities, never product metadata/requests. */
  iceServers?: readonly RTCIceServer[] | ((runtimeId: bigint) => Promise<readonly RTCIceServer[]>);
}): BrowserMediaHost {
  const { productId, label } = options;
  if (new URL(options.origin).origin !== options.origin || options.origin === location.origin) {
    throw new Error('Media:UnsafeContainer');
  }
  const indicator = document.createElement('div');
  indicator.className = 'host-media-indicator';
  indicator.setAttribute('aria-label', `${productId} trusted call controls`);
  indicator.style.cssText =
    'position:fixed;bottom:0;left:0;right:0;z-index:4000;isolation:isolate;pointer-events:auto;background:var(--bg-primary,#fff);color:var(--text-primary,#111);max-height:40dvh;overflow:auto;';
  document.body.append(indicator);

  let disposed = false;
  let frame: HTMLIFrameElement | null = null;
  let mount: HTMLElement | null = null;
  let expectedSrc = '';
  let provider: PermissionProvider | undefined;
  let authIdentity: string | undefined;
  let authorityEpoch = 0;
  let runtimeId: bigint | undefined;
  let removeFrameListeners: (() => void) | undefined;
  const scopes = new Set<BlockingModalScope>();
  const calling = new Map<string, CallingRequest>();
  let occluders: Element[] = [];
  const hex = (value: Uint8Array): string =>
    `0x${Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  function authorize(product: ProductContext, id?: bigint): void {
    if (
      disposed ||
      product.productId !== productId ||
      (product.executionKind !== 'App' && product.executionKind !== 'Worker') ||
      (id !== undefined && runtimeId !== id)
    ) {
      throw new Error('Media:RuntimeMismatch');
    }
  }
  function observeCalling(request: CallingRequest): void {
    if (disposed || request.value.network.length !== 32 || request.value.account.length !== 32) {
      return;
    }
    const key = `${hex(request.value.network)}:${hex(request.value.account)}`;
    if (!calling.has(key)) {
      calling.set(key, {
        tag: 'Calling',
        value: { network: request.value.network.slice(), account: request.value.account.slice() },
      });
      window.dispatchEvent(new CustomEvent('dotli:permission-changed', { detail: { label } }));
    }
  }
  function isolated(element: Element, id: bigint): boolean {
    // Product DOM is cross-origin, with host capture/fullscreen/top navigation
    // and popups blocked for this entire execution. Host peers, tracks, media
    // elements and private callback values never enter its DOM or message port.
    // Independent product RTC cannot obtain those host-owned objects.
    return (
      !disposed &&
      id === runtimeId &&
      element === frame &&
      frame.src === expectedSrc &&
      new URL(frame.src).origin === options.origin &&
      frame.parentElement === mount &&
      frame.sandbox.value === PROTECTED_MEDIA_SANDBOX &&
      !frame.allowFullscreen
    );
  }
  function measure(product: Element, compositor: Element): BrowserMediaGeometry | undefined {
    const rect = product.getBoundingClientRect();
    const base = compositor.getBoundingClientRect();
    const width = product.clientWidth;
    const height = product.clientHeight;
    if (!width || !height || !rect.width || !rect.height) {
      return undefined;
    }
    const scale = rect.width / width;
    if (Math.abs(rect.height / height - scale) > 0.001) {
      return undefined;
    }
    for (let node: Element | null = product; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        style.display === 'none' ||
        style.visibility !== 'visible' ||
        Number(style.opacity) !== 1 ||
        (style.transform !== 'none' && !TRANSLATION.test(style.transform)) ||
        style.contentVisibility === 'hidden'
      ) {
        return undefined;
      }
    }
    const visual = window.visualViewport;
    const left = Math.max(rect.left, base.left, visual?.offsetLeft ?? 0);
    const top = Math.max(rect.top, base.top, visual?.offsetTop ?? 0);
    const right = Math.min(rect.right, base.right, (visual?.offsetLeft ?? 0) + (visual?.width ?? innerWidth));
    const bottom = Math.min(
      rect.bottom,
      base.bottom,
      (visual?.offsetTop ?? 0) + (visual?.height ?? innerHeight),
      indicator.getBoundingClientRect().top,
    );
    // A rectangular layout cannot represent holes. Blank media, rather than
    // showing pixels beneath any trusted modal/popover/other host occlusion.
    for (const node of occluders) {
      if (
        !node.isConnected ||
        node === compositor ||
        node.contains(compositor) ||
        compositor.contains(node) ||
        indicator.contains(node) ||
        node === indicator
      ) {
        continue;
      }
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) {
        continue;
      }
      const box = node.getBoundingClientRect();
      if (box.width && box.height && box.left < right && box.right > left && box.top < bottom && box.bottom > top) {
        return undefined;
      }
    }
    return {
      left: rect.left - base.left + compositor.scrollLeft,
      top: rect.top - base.top + compositor.scrollTop,
      width,
      height,
      scale,
      deviceScale: devicePixelRatio * (visual?.scale ?? 1) * scale,
      clip: {
        x: (left - rect.left) / scale,
        y: (top - rect.top) / scale,
        width: Math.max(0, right - left) / scale,
        height: Math.max(0, bottom - top) / scale,
      },
      visible: document.visibilityState === 'visible',
    };
  }
  const backend = createBrowserMediaBackend({
    window,
    document,
    productId,
    indicatorMount: indicator,
    getProductElement: id => (id === runtimeId && frame?.isConnected === true ? frame : null),
    getCompositorMount: id => (id === runtimeId && mount?.isConnected === true ? mount : null),
    isProductIsolated: isolated,
    measureViewport: measure,
    // No product-supplied ICE and no invented public relay. This is the browser's
    // real host-candidate configuration. Cross-NAT TURN requires host facilities.
    iceServers: options.iceServers ?? [],
    async requestConsent(request, context) {
      if (disposed || context.productId !== productId || context.runtimeId !== runtimeId || context.signal.aborted) {
        throw blockingModalAbortError();
      }
      if (request.tag === 'Calling') {
        observeCalling(request);
      }
      const scope = options.coordinator.createScope();
      scopes.add(scope);
      const abort = (): void => {
        scope.dispose('Media operation cancelled');
      };
      context.signal.addEventListener('abort', abort, { once: true });
      try {
        const decision = await scope.enqueue(signal =>
          showPermissionRequestModal(label, request.tag, signal, {
            media: {
              productId,
              fields:
                request.tag === 'Calling'
                  ? [
                      ['Network genesis hash', hex(request.value.network)],
                      ['Account (sr25519)', hex(request.value.account)],
                    ]
                  : [],
            },
          }),
        );
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- disposal and cancellation happen while the modal awaits.
        if (disposed || context.signal.aborted || context.runtimeId !== runtimeId || decision === 'dismissed') {
          throw blockingModalAbortError();
        }
        return decision === 'granted';
      } finally {
        context.signal.removeEventListener('abort', abort);
        scope.dispose();
        scopes.delete(scope);
      }
    },
  });
  const refresh = (): void => {
    if (runtimeId !== undefined && !disposed) {
      backend.refreshViewport(runtimeId);
    }
  };
  const observer = new MutationObserver(records => {
    // The compositor's own geometry is host layout; changes inside it are not.
    if (
      records.every(
        record =>
          (record.target !== mount && mount?.contains(record.target) === true) || indicator.contains(record.target),
      )
    ) {
      return;
    }
    occluders = [...document.querySelectorAll('body *')];
    refresh();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'open'],
  });
  occluders = [...document.querySelectorAll('body *')];
  window.addEventListener('scroll', refresh, true);
  window.addEventListener('resize', refresh);
  window.visualViewport?.addEventListener('resize', refresh);
  window.visualViewport?.addEventListener('scroll', refresh);
  // Topbar auto-hide slides the compositor; settle on the final position.
  window.addEventListener('transitionend', refresh, true);
  const platform: Required<MediaPlatform> = {
    mediaBackendCapabilities(product) {
      authorize(product);
      return backend.mediaBackendCapabilities(product);
    },
    mediaBackendEvents(product, id) {
      authorize(product);
      if (runtimeId !== undefined && runtimeId !== id) {
        throw new Error('Media:RuntimeMismatch');
      }
      const first = runtimeId === undefined;
      const events = backend.mediaBackendEvents(product, id);
      runtimeId = id; // Only the trusted worker/core callback can supply this id.
      if (first && frame?.isConnected === true) {
        backend.attach(id);
      }
      return events;
    },
    async mediaBackendCommand(product, id, command) {
      if (command.tag === 'CloseRuntime' && !disposed && product.productId === productId) {
        const result = await backend.mediaBackendCommand(product, id, command);
        if (id === runtimeId) {
          runtimeId = undefined;
        }
        return result;
      }
      authorize(product, id);
      return backend.mediaBackendCommand(product, id, command);
    },
  };
  const host: BrowserMediaHost = {
    platform,
    bindProvider(value: PermissionProvider) {
      provider = value;
    },
    observeStorage(key: CoreStorageKey) {
      if (
        key.tag === 'PermissionAuthorization' &&
        key.value.productId === productId &&
        key.value.request.tag === 'Calling'
      ) {
        observeCalling(key.value.request);
      }
    },
    authChanged(state: AuthState) {
      if (disposed) {
        return;
      }
      const identity =
        state.tag === 'Connected' ? `${state.value.publicKey}:${state.value.identityAccountId ?? ''}` : undefined;
      if (authIdentity !== undefined && identity !== authIdentity) {
        authorityEpoch += 1;
        // The core authority watcher fences operations, stops sessions and
        // replaces signaling while retaining this product runtime's backend id.
        // An identity change must not manufacture a persisted permission denial.
        for (const scope of scopes) {
          scope.dispose('Media authority changed');
        }
        calling.clear();
        window.dispatchEvent(new CustomEvent('dotli:permission-changed', { detail: { label } }));
      }
      authIdentity = identity;
    },
    attach(element: HTMLIFrameElement, parent: HTMLElement) {
      if (disposed || frame !== null || new URL(element.src).origin !== options.origin) {
        throw new Error('Media:UnsafeContainer');
      }
      frame = element;
      mount = parent;
      expectedSrc = element.src;
      let loaded = false;
      const load = (): void => {
        if (loaded && runtimeId !== undefined) {
          host.dispose();
          return;
        }
        loaded = true;
        if (runtimeId !== undefined) {
          backend.attach(runtimeId);
        }
      };
      element.addEventListener('load', load);
      removeFrameListeners = () => {
        element.removeEventListener('load', load);
      };
      if (runtimeId !== undefined && element.isConnected) {
        backend.attach(runtimeId);
      }
    },
    async callingSettings() {
      const current = provider;
      const epoch = authorityEpoch;
      if (disposed || !current) {
        return [];
      }
      const result = await Promise.all(
        [...calling.values()].map(async request => ({
          productId,
          network: hex(request.value.network),
          account: hex(request.value.account),
          status: await current.getPermissionAuthorizationStatus(request),
          async revoke() {
            if (disposed || provider !== current || authorityEpoch !== epoch) {
              throw new Error('Media:RuntimeClosed');
            }
            await current.setPermissionAuthorizationStatus(request, 'NotDetermined');
            window.dispatchEvent(new CustomEvent('dotli:permission-changed', { detail: { label } }));
          },
        })),
      );
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- disposal can happen while statuses load.
      return disposed || provider !== current || authorityEpoch !== epoch ? [] : result;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const scope of scopes) {
        scope.dispose('Media runtime closed');
      }
      scopes.clear();
      backend.dispose();
      observer.disconnect();
      removeFrameListeners?.();
      window.removeEventListener('pagehide', disposeOnPageHide);
      window.removeEventListener('scroll', refresh, true);
      window.removeEventListener('resize', refresh);
      window.visualViewport?.removeEventListener('resize', refresh);
      window.visualViewport?.removeEventListener('scroll', refresh);
      window.removeEventListener('transitionend', refresh, true);
      indicator.remove();
      calling.clear();
      provider = undefined;
      frame = null;
      mount = null;
      mediaHosts.get(label)?.delete(host);
      if ((mediaHosts.get(label)?.size ?? 0) === 0) {
        mediaHosts.delete(label);
      }
    },
  };
  const disposeOnPageHide = (): void => {
    host.dispose();
  };
  window.addEventListener('pagehide', disposeOnPageHide);
  const hosts = mediaHosts.get(label) ?? new Set<BrowserMediaHost>();
  hosts.add(host);
  mediaHosts.set(label, hosts);
  return host;
}
