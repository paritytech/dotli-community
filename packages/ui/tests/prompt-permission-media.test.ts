// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TruapiHostWeb from '@parity/truapi-host/web';
import type {
  PermissionAuthorizationRequest,
  PermissionAuthorizationStatus,
  ProductContext,
} from '@parity/truapi-host';
import { createPromptPermission } from '../src/host-callbacks/PromptPermission.js';
import { createMediaHost, type BrowserMediaHost } from '../src/media-host.js';
import { createBlockingModalCoordinator } from '../src/blocking-modal-queue.js';
import { getPermissionStatus, registerPermissionAuthorizationProvider } from '../src/permissions.js';
import { ERRORS } from '../src/errors.js';
import { overlaysReady, resetOverlays } from './helpers/overlays.js';
import { must } from './support.js';

type BackendOptions = Parameters<typeof TruapiHostWeb.createBrowserMediaBackend>[0];

const backend = vi.hoisted((): { options?: BackendOptions } => ({}));

vi.mock('@parity/truapi-host/web', async importOriginal => {
  // vi.mock factories are hoisted above static imports, so the double loads lazily.
  const { fakeBrowserMediaBackend } = await import('./helpers/web-locks.js');
  return {
    ...(await importOriginal<typeof TruapiHostWeb>()),
    createBrowserMediaBackend: (options: BackendOptions) => {
      backend.options = options;
      return fakeBrowserMediaBackend();
    },
  };
});

const PRODUCT: ProductContext = { productId: 'myapp.paseo', executionKind: 'App' };

describe('raw capture in a protected Media container', () => {
  let store: Map<string, PermissionAuthorizationStatus>;
  let unregister: () => void;
  let media: BrowserMediaHost;

  beforeEach(() => {
    store = new Map();
    unregister = registerPermissionAuthorizationProvider('myapp', {
      getPermissionAuthorizationStatuses(requests: PermissionAuthorizationRequest[]) {
        return Promise.resolve(
          requests.map(request => (request.tag === 'Device' ? store.get(request.value) : undefined) ?? 'NotDetermined'),
        );
      },
      setPermissionAuthorizationStatus(request: PermissionAuthorizationRequest, status) {
        if (request.tag === 'Device') {
          store.set(request.value, status);
        }
        return Promise.resolve();
      },
    });
    media = createMediaHost({
      label: 'myapp',
      productId: PRODUCT.productId,
      origin: 'https://myapp.media.example',
      coordinator: createBlockingModalCoordinator(),
    });
  });

  afterEach(() => {
    media.dispose();
    unregister();
    resetOverlays();
  });

  it.each(['Camera', 'Microphone'] as const)(
    'As a protected Media product, a raw %s request is refused without a durable denial and host Media consent still prompts',
    async tag => {
      // When: the product asks for raw capture through the device permission path
      const raw = createPromptPermission('myapp').devicePermission(PRODUCT, tag);

      // Then: refused by error, so the core records nothing; no prompt either
      await expect(raw).rejects.toThrow(ERRORS.MEDIA_RAW_CAPTURE_REFUSED);
      expect(document.querySelector('[data-testid="signing-modal-backdrop"]')).toBeNull();
      expect(store.has(tag)).toBe(false);
      expect(await getPermissionStatus('myapp', tag)).toBe('ask');

      // When: host Media asks for the same device consent in a call
      const options = must(backend.options, 'Media backend options');
      media.platform.mediaBackendEvents(PRODUCT, 1n);
      const consent = options.requestConsent(
        { tag },
        {
          productId: PRODUCT.productId,
          runtimeId: 1n,
          operationId: `0x${'00'.repeat(32)}`,
          signal: new AbortController().signal,
        },
      );

      // Then: the user is asked and can allow it
      await overlaysReady();
      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="signing-modal-footer"] button')).not.toBeNull();
      });
      Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="signing-modal-footer"] button'))
        .find(button => button.textContent === 'Allow')
        ?.click();
      await expect(consent).resolves.toBe(true);
    },
  );
});
