import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlacedAvatar, PlacedAvatars } from '@parity/truapi-host';
import type { Window as HappyWindow } from 'happy-dom';
import {
  createAvatarProfileCache,
  createContactAvatarOverlay,
  type AvatarProfileCache,
  type AvatarSurfaceFit,
  type ContactAvatarOverlay,
} from '../src/profile/avatar-overlay.js';
import type { LoadedProfile } from '../src/profile/drawer.js';
import type { Mood } from '../src/profile/profile-record.js';
import { flush } from 'solid-js';
const revokeUrl = vi.fn<(url: string) => void>();

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const NOW_SECS = 1_800_000_000;

function mood(ttlSecs = 3_600): Mood {
  return { kind: 'calm', intensity: 'steady', setAt: NOW_SECS - 60, ttlSecs };
}

/** What each test reference opens to. */
const PROFILES: Record<string, LoadedProfile> = {
  both: { avatar: PNG, mood: mood() },
  photo: { avatar: PNG },
  mood: { avatar: null, mood: mood() },
  lapsing: { avatar: null, mood: { ...mood(), ttlSecs: 70 } },
  nothing: { avatar: null },
  expired: { avatar: null, mood: { ...mood(), ttlSecs: 30 } },
  svg: { avatar: new TextEncoder().encode('<svg/>') },
};

let loads: string[];
let urls: number;
const LOAD_MS = 10;

function loader(reference: string): () => Promise<LoadedProfile> {
  const profile = PROFILES[reference];
  if (profile === undefined) {
    throw new Error('unparseable');
  }
  return () => {
    loads.push(reference);
    return new Promise<LoadedProfile>(resolve => {
      setTimeout(() => {
        resolve(profile);
      }, LOAD_MS);
    });
  };
}

function frame(width: number, height: number): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;top:56px;left:0px;width:100%;height:500px;border:none;';
  Object.defineProperty(iframe, 'clientWidth', {
    configurable: true,
    get: () => width,
  });
  Object.defineProperty(iframe, 'clientHeight', {
    configurable: true,
    get: () => height,
  });
  document.body.appendChild(iframe);
  return iframe;
}

function slot(
  id: number,
  reference: string,
  rect: [number, number, number],
  clip: [number, number, number, number] = [0, 0, 10_000, 10_000],
  sharedAt = 1n,
): PlacedAvatar {
  return {
    slot: id,
    reference,
    rect: { x: rect[0], y: rect[1], width: rect[2], height: rect[2] },
    clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3] },
    sharedAt,
  };
}

function placement(surfaceWidth: number, surfaceHeight: number, avatars: PlacedAvatar[]): PlacedAvatars {
  return { surfaceWidth, surfaceHeight, avatars };
}

function layer(): HTMLElement | null {
  flush();
  return document.querySelector('[data-testid="contact-avatar-overlay"]');
}

function slots(): HTMLElement[] {
  flush();
  return [...document.querySelectorAll<HTMLElement>('[data-testid="contact-avatar-slot"]')];
}

/** An element's `[x, y, width, height]` as the overlay placed it. */
function box(element: Element | null | undefined): number[] {
  const style = (element as HTMLElement).style;
  const at = /^translate3d\(([-\d.]+)px, ([-\d.]+)px, 0\)$/.exec(style.transform);
  return [at?.[1], at?.[2], style.width, style.height].map(value => Number.parseFloat(value ?? ''));
}

function hidden(element: Element | undefined): boolean {
  flush();
  return getComputedStyle(element as HTMLElement).opacity === '0';
}

function fades(element: Element | undefined): boolean {
  flush();
  return getComputedStyle(element as HTMLElement).transition !== 'none';
}

/** Let loads finish and the next animation frame draw them. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(LOAD_MS);
  vi.advanceTimersToNextFrame();
  flush();
}

/** How long positions must hold still before a moved avatar shows again. */
const SETTLE_MS = 150;

// The test window is happy-dom's, whose device settings drive CSS media queries.
const happyWindow = window as unknown as HappyWindow;

describe('host-drawn contact avatars', () => {
  let cache: AvatarProfileCache;
  let overlay: ContactAvatarOverlay;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW_SECS * 1000 });
    loads = [];
    urls = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      urls += 1;
      return `blob:avatar-${String(urls)}`;
    });
    revokeUrl.mockReset();
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeUrl);
    cache = createAvatarProfileCache(loader, 1);
    overlay = createContactAvatarOverlay(cache);
  });

  afterEach(() => {
    overlay.dispose();
    cache.clear();
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function draw(
    fit: AvatarSurfaceFit,
    size: [number, number],
    placed: PlacedAvatars,
  ): Promise<HTMLIFrameElement> {
    const iframe = frame(...size);
    overlay.attach(iframe, fit);
    overlay.place(placed);
    await settle();
    return iframe;
  }

  it("places a web product's avatars in the frame's CSS pixels", async () => {
    const iframe = await draw(
      'viewport',
      [400, 800],
      placement(400, 800, [slot(1, 'photo', [16, 120, 44], [0, 100, 400, 600])]),
    );

    expect(layer()?.previousElementSibling).toBe(iframe);
    expect(box(slots()[0])).toEqual([0, 100, 400, 600]);
    expect(box(slots()[0]?.querySelector('[data-testid="contact-avatar"]'))).toEqual([16, 20, 44, 44]);
  });

  it('contain-fits a letterboxed PolkaVM framebuffer, centred', async () => {
    // 200x100 framebuffer in a 400x400 frame: scale 2, 100px bars above and below.
    await draw('contain', [400, 400], placement(200, 100, [slot(1, 'photo', [10, 20, 30], [0, 10, 200, 80])]));

    expect(box(slots()[0])).toEqual([0, 120, 400, 160]);
    expect(box(slots()[0]?.querySelector('[data-testid="contact-avatar"]'))).toEqual([20, 20, 60, 60]);
  });

  it('stretches a Tri2D surface over the whole frame', async () => {
    await draw('fill', [400, 300], placement(800, 600, [slot(1, 'photo', [100, 200, 88], [0, 0, 800, 600])]));

    expect(box(slots()[0])).toEqual([0, 0, 400, 300]);
    expect(box(slots()[0]?.querySelector('[data-testid="contact-avatar"]'))).toEqual([50, 100, 44, 44]);
  });

  it("cuts avatars to the product's clip and drops those outside it", async () => {
    await draw(
      'viewport',
      [400, 800],
      placement(400, 800, [
        // Half scrolled under the header that ends at y = 100.
        slot(1, 'photo', [16, 80, 44], [0, 100, 400, 600]),
        // Scrolled away entirely.
        slot(2, 'photo', [16, 20, 44], [0, 100, 400, 600]),
        // Clip beyond the surface is cut to it.
        slot(3, 'photo', [16, 760, 44], [0, 700, 400, 400]),
      ]),
    );

    const [first, last] = slots();
    expect(slots()).toHaveLength(2);
    expect(box(first)).toEqual([0, 100, 400, 600]);
    expect(box(first?.querySelector('[data-testid="contact-avatar"]'))).toEqual([16, -20, 44, 44]);
    expect(box(last)).toEqual([0, 700, 400, 100]);
  });

  it('draws the photo with its ring, the ring alone, or nothing', async () => {
    await draw(
      'viewport',
      [400, 800],
      placement(400, 800, [
        slot(1, 'both', [0, 0, 44]),
        slot(2, 'mood', [0, 50, 44]),
        slot(3, 'nothing', [0, 100, 44]),
        slot(4, 'expired', [0, 150, 44]),
        slot(5, 'svg', [0, 200, 44]),
        slot(6, 'not a reference', [0, 250, 44]),
      ]),
    );

    const [both, ring] = slots();
    expect(slots()).toHaveLength(2);
    expect(both?.querySelector('img')?.getAttribute('src')).toBe('blob:avatar-1');
    expect(both?.querySelector('[data-testid="mood-ring"]')).not.toBeNull();
    expect(ring?.querySelector('img')).toBeNull();
    const ringElement = ring?.querySelector<HTMLElement>('[data-testid="mood-ring"]');
    // The static ring wraps the circle and leaves its centre clear.
    expect(ringElement?.hasAttribute('data-static')).toBe(true);
    expect(ringElement?.style.width).toBe('66px');
    expect(ring?.querySelector('canvas')).toBeNull();
  });

  it('stops drawing a mood when it lapses', async () => {
    await draw(
      'viewport',
      [400, 800],
      placement(400, 800, [slot(1, 'lapsing', [0, 0, 44]), slot(2, 'both', [0, 50, 44])]),
    );
    expect(slots()).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(11_000);

    expect(slots()).toHaveLength(1);
    expect(slots()[0]?.querySelector('img')).not.toBeNull();
    expect(slots()[0]?.querySelector('[data-testid="mood-ring"]')).not.toBeNull();
  });

  it('reloads a renewed share and keeps the old photo until it arrives', async () => {
    const clip: [number, number, number, number] = [0, 0, 400, 800];
    await draw('viewport', [400, 800], placement(400, 800, [slot(1, 'photo', [0, 0, 44], clip, 5n)]));
    const src = (): string | null | undefined => slots()[0]?.querySelector('img')?.getAttribute('src');
    expect(src()).toBe('blob:avatar-1');

    // The same share placed again is served from the cache.
    overlay.place(placement(400, 800, [slot(1, 'photo', [0, 0, 44], clip, 5n)]));
    await settle();
    expect(loads).toEqual(['photo']);

    overlay.place(placement(400, 800, [slot(1, 'photo', [0, 0, 44], clip, 6n)]));
    vi.advanceTimersToNextFrame();
    expect(loads).toEqual(['photo', 'photo']);
    expect(src()).toBe('blob:avatar-1');
    expect(revokeUrl).not.toHaveBeenCalled();

    await settle();
    expect(src()).toBe('blob:avatar-2');
    expect(revokeUrl).toHaveBeenCalledWith('blob:avatar-1');

    // An older share arriving late does not reload.
    overlay.place(placement(400, 800, [slot(1, 'photo', [0, 0, 44], clip, 5n)]));
    await settle();
    expect(loads).toEqual(['photo', 'photo']);
    expect(src()).toBe('blob:avatar-2');
  });

  it('replaces the previous placement and removes the layer when cleared', async () => {
    await draw(
      'viewport',
      [400, 800],
      placement(400, 800, [slot(1, 'photo', [0, 0, 44]), slot(2, 'mood', [0, 50, 44])]),
    );
    const kept = slots()[1];

    overlay.place(placement(400, 800, [slot(2, 'mood', [0, 60, 44])]));
    await settle();
    expect(slots()).toEqual([kept]);
    expect(box(kept?.querySelector('[data-testid="contact-avatar"]'))).toEqual([0, 60, 44, 44]);

    overlay.place(placement(400, 800, []));
    expect(layer()).toBeNull();

    overlay.place(placement(400, 800, [slot(1, 'photo', [0, 0, 44])]));
    await settle();
    overlay.clear();
    expect(layer()).toBeNull();

    overlay.place(placement(400, 800, [slot(1, 'photo', [0, 0, 44])]));
    await settle();
    overlay.dispose();
    expect(layer()).toBeNull();
    overlay.place(placement(400, 800, [slot(1, 'photo', [0, 0, 44])]));
    await settle();
    expect(layer()).toBeNull();
  });

  it('draws a load begun under an earlier placement into the current one', async () => {
    const iframe = frame(400, 800);
    overlay.attach(iframe, 'viewport');
    overlay.place(placement(400, 800, [slot(1, 'photo', [0, 0, 44])]));
    overlay.place(placement(400, 800, [slot(2, 'photo', [0, 60, 44])]));
    await settle();

    expect(slots()).toHaveLength(1);
    expect(box(slots()[0]?.querySelector('[data-testid="contact-avatar"]'))).toEqual([0, 60, 44, 44]);
    expect(loads).toEqual(['photo']);
  });

  it("follows the frame's geometry and size", async () => {
    let width = 400;
    const iframe = frame(0, 0);
    Object.defineProperty(iframe, 'clientWidth', { get: () => width });
    Object.defineProperty(iframe, 'clientHeight', { get: () => 400 });
    overlay.attach(iframe, 'contain');
    overlay.place(placement(100, 100, [slot(1, 'photo', [0, 0, 10])]));
    await settle();

    iframe.style.transform = 'translateY(56px)';
    await settle();
    expect(layer()?.style.transform).toBe('translateY(56px)');
    expect(layer()?.style.top).toBe('56px');

    width = 800;
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersToNextFrame();
    expect(box(slots()[0])).toEqual([200, 0, 400, 400]);
  });

  it('loads a reference once and revokes its photo URL when evicted', async () => {
    const other = createContactAvatarOverlay(cache);
    const iframe = frame(400, 800);
    overlay.attach(iframe, 'viewport');
    other.attach(iframe, 'viewport');
    // Both ask while the first load is still in flight.
    overlay.place(placement(400, 800, [slot(1, 'photo', [0, 0, 44])]));
    other.place(placement(400, 800, [slot(7, 'photo', [0, 0, 44])]));
    await settle();
    expect(loads).toEqual(['photo']);

    // Released but kept: the cache holds one unused reference.
    overlay.place(placement(400, 800, []));
    other.dispose();
    expect(revokeUrl).not.toHaveBeenCalled();

    // A second released reference pushes the first out.
    overlay.place(placement(400, 800, [slot(1, 'both', [0, 0, 44])]));
    await settle();
    overlay.place(placement(400, 800, []));
    expect(revokeUrl).toHaveBeenCalledWith('blob:avatar-1');
    expect(revokeUrl).not.toHaveBeenCalledWith('blob:avatar-2');
  });

  it('never takes pointer events or reaches into the product frame', async () => {
    const iframe = frame(400, 800);
    iframe.style.pointerEvents = 'auto';
    const post = vi.fn();
    Object.defineProperty(iframe, 'contentWindow', {
      get: () => ({ postMessage: post }),
    });
    overlay.attach(iframe, 'viewport');
    overlay.place(placement(400, 800, [slot(1, 'both', [0, 0, 44])]));
    await settle();

    const root = layer();
    expect(root?.getAttribute('aria-hidden')).toBe('true');
    expect(root?.style.pointerEvents).toBe('none');
    for (const element of [root, ...(root?.querySelectorAll('*') ?? [])] as Element[]) {
      expect(getComputedStyle(element).pointerEvents).toBe('none');
    }
    expect(post).not.toHaveBeenCalled();
  });

  it('hides a moving avatar until positions hold still', async () => {
    await draw(
      'viewport',
      [400, 800],
      placement(400, 800, [slot(1, 'photo', [0, 0, 44]), slot(2, 'photo', [0, 50, 44])]),
    );
    const [still, moving] = slots();
    // New avatars fade in once positions settle.
    expect([hidden(still), hidden(moving)]).toEqual([true, true]);
    expect(fades(still)).toBe(true);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect([hidden(still), hidden(moving)]).toEqual([false, false]);

    // Scrolling: slot 2 moves with every placement, slot 1 shifts by less
    // than half a pixel.
    for (const y of [60, 70, 80]) {
      overlay.place(placement(400, 800, [slot(1, 'photo', [0, 0.4, 44]), slot(2, 'photo', [0, y, 44])]));
      vi.advanceTimersToNextFrame();
      expect([hidden(still), hidden(moving)]).toEqual([false, true]);
      await vi.advanceTimersByTimeAsync(SETTLE_MS - 50);
    }
    expect(hidden(moving)).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(hidden(moving)).toBe(false);
    expect(box(moving?.querySelector('[data-testid="contact-avatar"]'))).toEqual([0, 80, 44, 44]);
  });

  it('hides every avatar while the frame itself moves', async () => {
    const iframe = await draw(
      'viewport',
      [400, 800],
      placement(400, 800, [slot(1, 'photo', [0, 0, 44]), slot(2, 'photo', [0, 50, 44])]),
    );
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(slots().map(hidden)).toEqual([false, false]);

    // The topbar autohides: the frame slides up.
    iframe.style.transform = 'translateY(-56px)';
    await vi.advanceTimersByTimeAsync(1);
    expect(slots().map(hidden)).toEqual([true, true]);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(slots().map(hidden)).toEqual([false, false]);

    window.dispatchEvent(new Event('resize'));
    expect(slots().map(hidden)).toEqual([true, true]);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(slots().map(hidden)).toEqual([false, false]);
  });

  it('draws only the latest of several placements, once per frame', async () => {
    await draw('viewport', [400, 800], placement(400, 800, [slot(1, 'photo', [0, 0, 44])]));
    const anchor = slots()[0]?.querySelector('[data-testid="contact-avatar"]');

    for (const y of [10, 20, 30]) {
      overlay.place(placement(400, 800, [slot(1, 'photo', [0, y, 44])]));
    }
    flush();
    expect(box(anchor)).toEqual([0, 0, 44, 44]);
    vi.advanceTimersToNextFrame();
    flush();
    expect(box(anchor)).toEqual([0, 30, 44, 44]);
  });

  it('hides and shows without fading under reduced motion', async () => {
    const device = happyWindow.happyDOM.settings.device;
    device.prefersReducedMotion = 'reduce';
    try {
      await draw('viewport', [400, 800], placement(400, 800, [slot(1, 'photo', [0, 0, 44])]));
      const [drawn] = slots();
      expect([hidden(drawn), fades(drawn)]).toEqual([true, false]);
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
      expect([hidden(drawn), fades(drawn)]).toEqual([false, false]);
    } finally {
      device.prefersReducedMotion = 'no-preference';
    }
  });
});
