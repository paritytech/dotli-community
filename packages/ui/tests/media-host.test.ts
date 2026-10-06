// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as TruapiHostWeb from '@parity/truapi-host/web';
import { createMediaHost, parseMediaIceServers, type BrowserMediaHost } from '../src/media-host.js';
import { must } from './support.js';
import { createBlockingModalCoordinator } from '../src/blocking-modal-queue.js';

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

const TURN = { urls: ['turns:turn.example:5349'], username: 'dotli', credential: 'relay-secret' };

let host: BrowserMediaHost | undefined;

function mediaHost(iceServers?: readonly RTCIceServer[]): BackendOptions {
  host = createMediaHost({
    label: 'myapp',
    productId: 'myapp.paseo',
    origin: 'https://myapp.media.example',
    coordinator: createBlockingModalCoordinator(),
    ...(iceServers === undefined ? {} : { iceServers }),
  });
  return must(backend.options, 'Media backend options');
}

afterEach(() => {
  host?.dispose();
  host = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('Media ICE configuration', () => {
  it('As a dotli integrator, the deployment TURN relays reach the backend and no transport policy is set', () => {
    // Given
    vi.stubEnv('VITE_MEDIA_ICE_SERVERS', JSON.stringify([{ ...TURN, urls: 'turn:turn.example:3478' }, TURN]));

    // When
    const options = mediaHost();

    // Then
    expect(options.iceServers).toEqual([{ ...TURN, urls: ['turn:turn.example:3478'] }, TURN]);
    expect(options).not.toHaveProperty('iceTransportPolicy');
  });

  it('As a dotli integrator, trusted host ICE servers take precedence over the build configuration', () => {
    vi.stubEnv('VITE_MEDIA_ICE_SERVERS', JSON.stringify([TURN]));
    const own = [{ urls: ['turn:own.example'], username: 'u', credential: 'c' }];

    expect(mediaHost(own).iceServers).toBe(own);
  });

  it('As a dotli integrator, an unset relay configuration yields no ICE servers', () => {
    expect(parseMediaIceServers(undefined)).toEqual([]);
    expect(parseMediaIceServers('  ')).toEqual([]);
  });

  it.each([
    ['not JSON', '{'],
    ['not an array', JSON.stringify(TURN)],
    ['a STUN server', JSON.stringify([{ ...TURN, urls: ['stun:stun.example'] }])],
    ['a server without credentials', JSON.stringify([{ urls: TURN.urls }])],
    ['unknown fields', JSON.stringify([{ ...TURN, credentialType: 'oauth' }])],
    ['empty urls', JSON.stringify([{ ...TURN, urls: [] }])],
  ])('As a dotli integrator, a relay configuration with %s is rejected', (_name, raw) => {
    expect(() => parseMediaIceServers(raw)).toThrow('Media:InvalidIceServers');
  });

  it('As a dotli integrator, an invalid relay configuration fails before the host touches the page', () => {
    vi.stubEnv('VITE_MEDIA_ICE_SERVERS', '[{"urls":"stun:stun.example"}]');

    expect(() => mediaHost()).toThrow('Media:InvalidIceServers');
    expect(document.querySelector('.host-media-indicator')).toBeNull();
  });
});

describe('Media viewport occlusion', () => {
  function rect(left: number, top: number, width: number, height: number): DOMRect {
    return DOMRect.fromRect({ x: left, y: top, width, height });
  }

  it('As a dotli integrator, the per-frame occluder scan reads styles only for elements overlapping the media', () => {
    // Given: a compositor with the product frame, and many host elements elsewhere
    const rects = new Map<Element, DOMRect>();
    const compositor = document.createElement('div');
    const frame = document.createElement('iframe');
    compositor.append(frame);
    document.body.append(compositor);
    rects.set(compositor, rect(0, 0, 400, 300));
    rects.set(frame, rect(0, 0, 400, 300));
    Object.defineProperty(frame, 'clientWidth', { value: 400 });
    Object.defineProperty(frame, 'clientHeight', { value: 300 });
    const distant = Array.from({ length: 50 }, (_, index) => {
      const element = document.createElement('div');
      document.body.append(element);
      rects.set(element, rect(500 + index, 0, 10, 10));
      return element;
    });
    const covering = document.createElement('div');
    rects.set(covering, rect(100, 100, 10, 10));
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return (
        rects.get(this) ?? (this.classList.contains('host-media-indicator') ? rect(0, 768, 1024, 0) : rect(0, 0, 0, 0))
      );
    });
    const options = mediaHost();
    const styled = new Set<Element>();
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      styled.add(element);
      return {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        transform: 'none',
        contentVisibility: 'visible',
      } as CSSStyleDeclaration;
    });

    // When
    const geometry = options.measureViewport?.(frame, compositor, 1n);
    // Then: visible geometry, and no style read for any non-overlapping element
    expect(geometry).toMatchObject({ width: 400, height: 300, scale: 1 });
    expect(distant.filter(element => styled.has(element))).toEqual([]);

    // When: a visible host element overlaps the media
    document.body.append(covering);
    return vi.waitFor(() => {
      // Then: media blanks rather than show pixels beneath it
      expect(options.measureViewport?.(frame, compositor, 1n)).toBeUndefined();
      expect(styled.has(covering)).toBe(true);
    });
  });
});
