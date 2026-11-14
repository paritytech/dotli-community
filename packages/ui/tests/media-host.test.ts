// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as TruapiHostWeb from '@parity/truapi-host/web';
import {
  createMediaHost,
  MEDIA_TURN_PATH,
  mediaTurnIceServers,
  toMediaIceServers,
  type BrowserMediaHost,
} from '../src/media-host.js';
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

/** Cloudflare `credentials/generate` answer, relayed unchanged by the shell route. */
const CLOUDFLARE = {
  iceServers: [
    {
      urls: [
        'stun:stun.cloudflare.com:3478',
        'stun:stun.cloudflare.com:53',
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'cf-user',
      credential: 'cf-credential',
    },
  ],
};

const CLOUDFLARE_RELAYS = [
  {
    urls: [
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turn:turn.cloudflare.com:3478?transport=tcp',
      'turns:turn.cloudflare.com:5349?transport=tcp',
      'turns:turn.cloudflare.com:443?transport=tcp',
    ],
    username: 'cf-user',
    credential: 'cf-credential',
  },
];

function turnResponse(body: unknown, ttl: string | null = '43200', status = 201): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: ttl === null ? {} : { 'Dotli-Media-Turn-Ttl': ttl },
  });
}

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
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('Media ICE configuration', () => {
  it('As a dotli integrator, the shell TURN route supplies relays and no transport policy is set', async () => {
    // Given
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(turnResponse(CLOUDFLARE));

    // When
    const options = mediaHost();
    const iceServers = options.iceServers;

    // Then
    expect(options).not.toHaveProperty('iceTransportPolicy');
    expect(typeof iceServers).toBe('function');
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect((iceServers as (runtimeId: bigint) => Promise<RTCIceServer[]>)(1n)).resolves.toEqual(
      CLOUDFLARE_RELAYS,
    );
    const [url, init] = must(fetchSpy.mock.calls[0], 'TURN route request');
    expect(url).toBe(`${location.origin}${MEDIA_TURN_PATH}`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' });
  });

  it('As a dotli integrator, trusted host ICE servers take precedence over the TURN route', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const own = [{ urls: ['turn:own.example'], username: 'u', credential: 'c' }];

    expect(mediaHost(own).iceServers).toBe(own);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, only credentialed turn:/turns: relays off port 53 survive conversion', () => {
    expect(toMediaIceServers(CLOUDFLARE)).toEqual(CLOUDFLARE_RELAYS);
    expect(toMediaIceServers({ iceServers: { ...TURN, urls: 'turn:turn.example:3478' } })).toEqual([
      { ...TURN, urls: ['turn:turn.example:3478'] },
    ]);
    expect(toMediaIceServers({ iceServers: [{ ...TURN, credentialType: 'oauth', extra: 1 }] })).toEqual([TURN]);
    expect(
      toMediaIceServers({ iceServers: [{ ...TURN, urls: ['turn:[2001:db8::1]:53', 'turns:[2001:db8::1]:5349'] }] }),
    ).toEqual([{ ...TURN, urls: ['turns:[2001:db8::1]:5349'] }]);
  });

  it.each([
    ['no iceServers', {}],
    ['null', null],
    ['only STUN', { iceServers: [{ ...TURN, urls: ['stun:stun.example:3478'] }] }],
    [
      'only port 53',
      { iceServers: [{ ...TURN, urls: ['turn:turn.example:53', 'turns:turn.example:53?transport=tcp'] }] },
    ],
    ['no credential', { iceServers: [{ urls: TURN.urls, username: 'dotli' }] }],
    ['an empty username', { iceServers: [{ ...TURN, username: '' }] }],
    ['empty urls', { iceServers: [{ ...TURN, urls: [] }] }],
  ])('As a dotli integrator, a TURN answer with %s yields no relay', (_name, body) => {
    expect(toMediaIceServers(body)).toEqual([]);
  });
});

describe('Media TURN credentials', () => {
  const TURN_URL = 'https://shell.example/__dotli-media/turn';

  function source(
    responses: (() => Promise<Response>)[],
    clock: { now: number },
  ): { fetchImpl: Mock<typeof fetch>; iceServers: () => Promise<RTCIceServer[]> } {
    const fetchImpl = vi.fn<typeof fetch>(() => must(responses.shift(), 'unexpected TURN request')());
    return { fetchImpl, iceServers: mediaTurnIceServers({ fetch: fetchImpl, now: () => clock.now, url: TURN_URL }) };
  }

  it('As a caller, credentials are reused for two thirds of their lifetime, then minted again', async () => {
    // Given
    const clock = { now: 1_000_000 };
    const fresh = { iceServers: [{ ...TURN, credential: 'second' }] };
    const { fetchImpl, iceServers } = source(
      [() => Promise.resolve(turnResponse({ iceServers: [TURN] }, '3600')), () => Promise.resolve(turnResponse(fresh))],
      clock,
    );

    // When / Then
    await expect(iceServers()).resolves.toEqual([TURN]);
    clock.now += 2_399_999;
    await expect(iceServers()).resolves.toEqual([TURN]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock.now += 1;
    await expect(iceServers()).resolves.toEqual(fresh.iceServers);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(TURN_URL);
  });

  it('As a caller, concurrent peers share one TURN request', async () => {
    const clock = { now: 0 };
    let resolve: (response: Response) => void = () => undefined;
    const { fetchImpl, iceServers } = source([() => new Promise<Response>(done => (resolve = done))], clock);

    const first = iceServers();
    const second = iceServers();
    resolve(turnResponse({ iceServers: [TURN] }));

    await expect(Promise.all([first, second])).resolves.toEqual([[TURN], [TURN]]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('As a caller, credentials without an announced lifetime are used once', async () => {
    const clock = { now: 0 };
    const { fetchImpl, iceServers } = source(
      [
        () => Promise.resolve(turnResponse({ iceServers: [TURN] }, null)),
        () => Promise.resolve(turnResponse({ iceServers: [TURN] }, 'soon')),
        () => Promise.resolve(turnResponse({ iceServers: [TURN] }, '0')),
      ],
      clock,
    );

    for (let call = 0; call < 3; call += 1) {
      await expect(iceServers()).resolves.toEqual([TURN]);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['unreachable', () => Promise.reject(new TypeError('Failed to fetch')), 'is unreachable'],
    ['unconfigured', () => Promise.resolve(turnResponse('', null, 503)), 'answered HTTP 503'],
    ['rate limited', () => Promise.resolve(turnResponse('', null, 429)), 'answered HTTP 429'],
    ['serving HTML', () => Promise.resolve(turnResponse('<!doctype html>')), 'answered invalid JSON'],
    [
      'relay-less',
      () => Promise.resolve(turnResponse({ iceServers: [{ urls: ['stun:stun.example'] }] })),
      'returned no credentialed turn:/turns: relay',
    ],
  ])('As a caller, a %s TURN route fails closed and is retried by the next peer', async (_name, failure, reason) => {
    // Given
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const clock = { now: 0 };
    const { fetchImpl, iceServers } = source(
      [failure, () => Promise.resolve(turnResponse({ iceServers: [TURN] }))],
      clock,
    );

    // When / Then
    await expect(iceServers()).rejects.toThrow(`Media:NoTurnRelay: ${MEDIA_TURN_PATH} ${reason}`);
    expect(error).toHaveBeenCalledWith('[media]', expect.stringContaining('Media:NoTurnRelay'));
    await expect(iceServers()).resolves.toEqual([TURN]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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

  describe('host UI over the media', () => {
    const defaults = {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      transform: 'none',
      contentVisibility: 'visible',
      position: 'static',
      zIndex: 'auto',
      isolation: 'auto',
      willChange: 'auto',
    };

    /**
     * A compositor laid out like bridge.ts, and a toast stack overlapping the
     * media's lower-right corner, as the persistent "Get Polkadot Desktop" one.
     */
    function layout(
      stack: Record<string, string>,
      options: { before?: boolean; wrapper?: Record<string, string> } = {},
    ): { frame: HTMLIFrameElement; compositor: HTMLDivElement } {
      const rects = new Map<Element, DOMRect>();
      const styles = new Map<Element, Record<string, string>>();
      const compositor = document.createElement('div');
      const frame = document.createElement('iframe');
      compositor.append(frame);
      document.body.append(compositor);
      rects.set(compositor, rect(0, 0, 400, 300));
      rects.set(frame, rect(0, 0, 400, 300));
      styles.set(compositor, { position: 'fixed', isolation: 'isolate', zIndex: '0' });
      styles.set(frame, { position: 'absolute', zIndex: '1' });
      Object.defineProperty(frame, 'clientWidth', { value: 400 });
      Object.defineProperty(frame, 'clientHeight', { value: 300 });
      const toasts = document.createElement('div');
      const toast = document.createElement('div');
      const title = document.createElement('span');
      toast.append(title);
      toasts.append(toast);
      let outer: HTMLElement = toasts;
      if (options.wrapper) {
        outer = document.createElement('div');
        styles.set(outer, options.wrapper);
        outer.append(toasts);
      }
      if (options.before === true) {
        document.body.prepend(outer);
      } else {
        document.body.append(outer);
      }
      styles.set(toasts, stack);
      for (const element of [toasts, toast, title]) {
        rects.set(element, rect(250, 220, 140, 70));
      }
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        return (
          rects.get(this) ??
          (this.classList.contains('host-media-indicator') ? rect(0, 768, 1024, 0) : rect(0, 0, 0, 0))
        );
      });
      vi.spyOn(window, 'getComputedStyle').mockImplementation(
        element => ({ ...defaults, ...styles.get(element) }) as unknown as CSSStyleDeclaration,
      );
      return { frame, compositor };
    }

    it('As a caller, my pictures keep rendering under a host toast that paints above them', () => {
      // Given: the fixed z-index 900 toast stack over part of the call
      const { frame, compositor } = layout({ position: 'fixed', zIndex: '900' });
      const options = mediaHost();

      // When
      const geometry = options.measureViewport?.(frame, compositor, 1n);

      // Then: the whole product stays measured; the toast stacks over the planes
      expect(geometry).toMatchObject({ width: 400, height: 300, clip: { x: 0, y: 0, width: 400, height: 300 } });
    });

    it('As a caller, my pictures keep rendering under later host UI at the same z-index', () => {
      // Given: a positioned host element after the compositor, at its z-index
      const { frame, compositor } = layout({ position: 'absolute', zIndex: '0' });
      const options = mediaHost();

      // Then
      expect(options.measureViewport?.(frame, compositor, 1n)).toMatchObject({ width: 400, height: 300 });
    });

    it.each([
      ['beneath the compositor by z-index', { position: 'fixed', zIndex: '-1' }, {}],
      ['in normal flow', {}, {}],
      ['positioned at the same z-index before the compositor', { position: 'absolute', zIndex: '0' }, { before: true }],
      [
        'inside a lower stacking context',
        { position: 'fixed', zIndex: '900' },
        { before: true, wrapper: { position: 'relative', zIndex: '0' } },
      ],
      [
        'inside an element whose stacking context is not modelled',
        { position: 'fixed', zIndex: '900' },
        { wrapper: { willChange: 'transform' } },
      ],
    ])('As a caller, media blanks rather than cover host UI %s', (_, stack, placement) => {
      // Given
      const { frame, compositor } = layout(stack, placement);
      const options = mediaHost();

      // Then: a plane could cover it, so nothing is drawn
      expect(options.measureViewport?.(frame, compositor, 1n)).toBeUndefined();
    });
  });
});
