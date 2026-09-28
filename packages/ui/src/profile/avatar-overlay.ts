// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Host-drawn contact avatars over a product frame (vanilla DOM).
//
// A product reports where its contact avatars sit; the core keeps only the
// contacts who shared a profile with the user and hands each slot's
// reference to the host. The host draws the photo and mood ring on its own
// layer above the product iframe. The layer takes no pointer events, so taps
// still reach the product, and nothing is ever posted back into the frame:
// the product never learns who shared or what they shared.

import type { AvatarRect } from "@parity/truapi";
import type { PlacedAvatars } from "@parity/truapi-host";
import { log } from "@dotli/shared/log";
import { rasterImageType, type LoadedProfile } from "./drawer";
import { createMoodRing, type MoodRingHandle } from "./mood-ring";
import { moodIsCurrent, type Mood } from "./profile-record";

/**
 * How a product's surface units land on its iframe's CSS box.
 *
 * - `viewport`: a web product; one unit is one CSS pixel of the iframe.
 * - `contain`: a PolkaVM framebuffer, contain-fitted and centred, as the
 *   sandbox draws `#dotli-polkavm-canvas[data-polkavm-profile="framebuffer"]`.
 * - `fill`: a PolkaVM Tri2D or WebGPU canvas stretched over the whole frame.
 */
export type AvatarSurfaceFit = "viewport" | "contain" | "fill";

export interface SurfaceMapping {
  readonly scaleX: number;
  readonly scaleY: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Map a `surfaceWidth` x `surfaceHeight` surface onto a `boxWidth` x `boxHeight` frame. */
export function surfaceMapping(
  fit: AvatarSurfaceFit,
  surfaceWidth: number,
  surfaceHeight: number,
  boxWidth: number,
  boxHeight: number,
): SurfaceMapping {
  if (fit === "viewport") {
    return { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
  }
  if (fit === "fill") {
    return {
      scaleX: boxWidth / surfaceWidth,
      scaleY: boxHeight / surfaceHeight,
      offsetX: 0,
      offsetY: 0,
    };
  }
  const scale = Math.min(boxWidth / surfaceWidth, boxHeight / surfaceHeight);
  return {
    scaleX: scale,
    scaleY: scale,
    offsetX: (boxWidth - surfaceWidth * scale) / 2,
    offsetY: (boxHeight - surfaceHeight * scale) / 2,
  };
}

/** What the overlay draws for one reference: a photo, a mood, both or neither. */
export interface AvatarProfile {
  readonly photoUrl: string | null;
  readonly mood?: Mood;
}

/** Parse a reference into its loader; throws for one the host cannot parse. */
export type AvatarProfileLoader = (
  reference: string,
) => (signal: AbortSignal) => Promise<LoadedProfile>;

/**
 * Loaded profiles shared by every overlay, keyed by reference. References a
 * placement shows are retained; released ones stay for a while so a list
 * scrolling back does not refetch, and their blob URLs are revoked when they
 * are evicted.
 */
export interface AvatarProfileCache {
  /** The settled profile; `null` when there is nothing to draw, `undefined` while unknown. */
  peek(reference: string): AvatarProfile | null | undefined;
  /** Load a reference once, however many overlays ask. */
  load(reference: string): Promise<void>;
  retain(reference: string): void;
  release(reference: string): void;
}

interface CacheEntry {
  users: number;
  value: AvatarProfile | null | undefined;
  loading: Promise<void> | null;
  readonly aborter: AbortController;
}

/** Released references kept loaded by default. */
const KEEP_UNUSED = 32;

export function createAvatarProfileCache(
  loader: AvatarProfileLoader,
  keepUnused = KEEP_UNUSED,
): AvatarProfileCache {
  const entries = new Map<string, CacheEntry>();
  // Insertion order is release order: the first is the next to go.
  const unused = new Set<string>();

  const entryFor = (reference: string): CacheEntry => {
    let entry = entries.get(reference);
    if (entry === undefined) {
      entry = {
        users: 0,
        value: undefined,
        loading: null,
        aborter: new AbortController(),
      };
      entries.set(reference, entry);
    }
    return entry;
  };

  const evict = (reference: string): void => {
    const entry = entries.get(reference);
    unused.delete(reference);
    if (entry === undefined) {
      return;
    }
    entries.delete(reference);
    entry.aborter.abort();
    const photoUrl = entry.value?.photoUrl;
    if (photoUrl !== undefined && photoUrl !== null) {
      URL.revokeObjectURL(photoUrl);
    }
  };

  const settle = (
    reference: string,
    entry: CacheEntry,
    loaded: LoadedProfile | null,
  ): void => {
    if (entries.get(reference) !== entry) {
      return;
    }
    const bytes = loaded?.avatar ?? null;
    const type = bytes === null ? null : rasterImageType(bytes);
    const photoUrl =
      bytes === null || type === null
        ? null
        : URL.createObjectURL(
            new Blob([bytes as Uint8Array<ArrayBuffer>], { type }),
          );
    entry.value =
      loaded === null || (photoUrl === null && loaded.mood === undefined)
        ? null
        : { photoUrl, mood: loaded.mood };
    entry.loading = null;
  };

  return {
    peek(reference) {
      return entries.get(reference)?.value;
    },
    load(reference) {
      const entry = entryFor(reference);
      if (entry.value !== undefined) {
        return Promise.resolve();
      }
      if (entry.loading !== null) {
        return entry.loading;
      }
      let run: (signal: AbortSignal) => Promise<LoadedProfile>;
      try {
        run = loader(reference);
      } catch {
        // An unparseable reference draws nothing; the product is not told.
        settle(reference, entry, null);
        return Promise.resolve();
      }
      entry.loading = run(entry.aborter.signal).then(
        (loaded) => {
          settle(reference, entry, loaded);
        },
        (error: unknown) => {
          // Name only: no error on this path carries the reference.
          log.debug(
            "[profile] contact avatar load failed:",
            error instanceof Error ? error.name : typeof error,
          );
          settle(reference, entry, null);
        },
      );
      return entry.loading;
    },
    retain(reference) {
      entryFor(reference).users += 1;
      unused.delete(reference);
    },
    release(reference) {
      const entry = entries.get(reference);
      if (entry === undefined || entry.users === 0) {
        return;
      }
      entry.users -= 1;
      if (entry.users > 0) {
        return;
      }
      // A failed load is retried the next time the reference is placed.
      if (entry.value === null) {
        evict(reference);
        return;
      }
      unused.add(reference);
      for (const oldest of unused) {
        if (unused.size <= keepUnused) {
          break;
        }
        evict(oldest);
      }
    },
  };
}

/** One product frame's avatar layer. */
export interface ContactAvatarOverlay {
  /** Draw over `frame`; placements made before this wait for it. */
  attach(frame: HTMLIFrameElement, fit: AvatarSurfaceFit): void;
  /** Replace everything drawn with `placed`; no avatars clears the layer. */
  place(placed: PlacedAvatars): void;
  /** Draw nothing until the next placement, as when the product restarts. */
  clear(): void;
  /** Remove the layer and stop tracking the frame for good. */
  dispose(): void;
}

interface SlotView {
  readonly root: HTMLElement;
  readonly anchor: HTMLElement;
  photo: HTMLElement | null;
  photoUrl: string | null;
  ring: MoodRingHandle | null;
  ringMood: Mood | null;
  ringPx: number;
}

/** Latest a timer can be armed for (setTimeout's signed 32-bit bound). */
const MAX_TIMER_MS = 2_147_483_647;

function px(value: number): string {
  return `${String(value)}px`;
}

function setBox(
  element: HTMLElement,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  element.style.left = px(x);
  element.style.top = px(y);
  element.style.width = px(w);
  element.style.height = px(h);
}

function stopView(view: SlotView): void {
  view.ring?.stop();
  view.root.remove();
}

export function createContactAvatarOverlay(
  cache: AvatarProfileCache,
): ContactAvatarOverlay {
  const layer = document.createElement("div");
  layer.className = "contact-avatar-overlay";
  layer.setAttribute("aria-hidden", "true");

  const views = new Map<number, SlotView>();
  const waiting = new Set<string>();
  let retained: readonly string[] = [];
  let placed: PlacedAvatars | null = null;
  let frame: HTMLIFrameElement | null = null;
  let fit: AvatarSurfaceFit = "viewport";
  let lapseTimer: ReturnType<typeof setTimeout> | null = null;
  let untrack: (() => void) | null = null;
  let disposed = false;

  // The layer copies the frame's inline geometry (fixed box, topbar
  // transform and its transition), so it moves with the frame exactly.
  const mirror = (): void => {
    if (frame === null) {
      return;
    }
    layer.style.cssText = frame.style.cssText;
    layer.style.pointerEvents = "none";
  };

  const clearViews = (): void => {
    for (const view of views.values()) {
      stopView(view);
    }
    views.clear();
  };

  const updateView = (
    slot: number,
    rect: AvatarRect,
    clip: { x0: number; y0: number; x1: number; y1: number },
    map: SurfaceMapping,
    profile: AvatarProfile,
    mood: Mood | undefined,
  ): void => {
    let view = views.get(slot);
    if (view === undefined) {
      const root = document.createElement("div");
      root.className = "contact-avatar-slot";
      const anchor = document.createElement("div");
      anchor.className = "contact-avatar";
      root.appendChild(anchor);
      view = {
        root,
        anchor,
        photo: null,
        photoUrl: null,
        ring: null,
        ringMood: null,
        ringPx: 0,
      };
      views.set(slot, view);
    }
    layer.appendChild(view.root);
    setBox(
      view.root,
      map.offsetX + clip.x0 * map.scaleX,
      map.offsetY + clip.y0 * map.scaleY,
      (clip.x1 - clip.x0) * map.scaleX,
      (clip.y1 - clip.y0) * map.scaleY,
    );
    const width = rect.width * map.scaleX;
    const height = rect.height * map.scaleY;
    setBox(
      view.anchor,
      (rect.x - clip.x0) * map.scaleX,
      (rect.y - clip.y0) * map.scaleY,
      width,
      height,
    );

    if (view.photoUrl !== profile.photoUrl) {
      view.photo?.remove();
      view.photo = null;
      view.photoUrl = profile.photoUrl;
      if (profile.photoUrl !== null) {
        const photo = document.createElement("div");
        photo.className = "contact-avatar-photo";
        const img = document.createElement("img");
        img.alt = "";
        img.draggable = false;
        img.decoding = "async";
        img.src = profile.photoUrl;
        photo.appendChild(img);
        view.anchor.appendChild(photo);
        view.photo = photo;
      }
    }

    const ringPx = Math.round(Math.min(width, height));
    if (view.ringMood !== (mood ?? null) || view.ringPx !== ringPx) {
      view.ring?.stop();
      view.ring?.element.remove();
      view.ring = null;
      view.ringMood = mood ?? null;
      view.ringPx = ringPx;
      if (mood !== undefined) {
        view.ring = createMoodRing(mood, ringPx, { webgl: false });
        view.anchor.prepend(view.ring.element);
      }
    }
  };

  const render = (): void => {
    if (lapseTimer !== null) {
      clearTimeout(lapseTimer);
      lapseTimer = null;
    }
    if (disposed || frame === null || placed === null) {
      clearViews();
      layer.remove();
      return;
    }
    const current = placed;
    const map = surfaceMapping(
      fit,
      current.surfaceWidth,
      current.surfaceHeight,
      frame.clientWidth,
      frame.clientHeight,
    );
    const nowSecs = Math.floor(Date.now() / 1000);
    let nextLapse = Number.POSITIVE_INFINITY;
    const drawn = new Set<number>();
    for (const avatar of current.avatars) {
      const profile = cache.peek(avatar.reference);
      if (profile === undefined) {
        if (!waiting.has(avatar.reference)) {
          waiting.add(avatar.reference);
          // Draw into whatever placement is current once it arrives.
          void cache.load(avatar.reference).then(() => {
            waiting.delete(avatar.reference);
            render();
          });
        }
        continue;
      }
      if (profile === null) {
        continue;
      }
      const mood =
        profile.mood !== undefined && moodIsCurrent(profile.mood, nowSecs)
          ? profile.mood
          : undefined;
      if (profile.photoUrl === null && mood === undefined) {
        continue;
      }
      const { rect, clip } = avatar;
      // The slot box is the product's clip cut to the surface. It hides
      // whatever of the photo circle and its ring falls outside, so the
      // photo shows the circle's box within the clip.
      const visible = {
        x0: Math.max(clip.x, 0),
        y0: Math.max(clip.y, 0),
        x1: Math.min(clip.x + clip.width, current.surfaceWidth),
        y1: Math.min(clip.y + clip.height, current.surfaceHeight),
      };
      if (
        Math.min(visible.x1, rect.x + rect.width) <=
          Math.max(visible.x0, rect.x) ||
        Math.min(visible.y1, rect.y + rect.height) <=
          Math.max(visible.y0, rect.y)
      ) {
        continue;
      }
      if (mood !== undefined) {
        nextLapse = Math.min(nextLapse, mood.setAt + mood.ttlSecs);
      }
      drawn.add(avatar.slot);
      updateView(avatar.slot, rect, visible, map, profile, mood);
    }
    for (const [slot, view] of views) {
      if (!drawn.has(slot)) {
        stopView(view);
        views.delete(slot);
      }
    }
    if (views.size === 0) {
      layer.remove();
    } else if (layer.previousElementSibling !== frame) {
      frame.after(layer);
    }
    if (Number.isFinite(nextLapse)) {
      lapseTimer = setTimeout(
        render,
        Math.min(MAX_TIMER_MS, Math.max(0, (nextLapse - nowSecs) * 1000)),
      );
    }
  };

  const show = (next: PlacedAvatars | null): void => {
    const references = next?.avatars.map((avatar) => avatar.reference) ?? [];
    // Retain the new set before releasing the old, so a reference in both
    // is never evicted in between.
    for (const reference of references) {
      cache.retain(reference);
    }
    for (const reference of retained) {
      cache.release(reference);
    }
    retained = references;
    placed = next;
    render();
  };

  return {
    attach(target, surfaceFit) {
      if (disposed) {
        return;
      }
      untrack?.();
      frame = target;
      fit = surfaceFit;
      mirror();
      const onChange = (): void => {
        mirror();
        render();
      };
      const styleObserver = new MutationObserver(onChange);
      styleObserver.observe(target, {
        attributes: true,
        attributeFilter: ["style"],
      });
      const resizeObserver =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(render);
      resizeObserver?.observe(target);
      window.addEventListener("resize", render);
      untrack = () => {
        styleObserver.disconnect();
        resizeObserver?.disconnect();
        window.removeEventListener("resize", render);
        untrack = null;
      };
      render();
    },
    place(next) {
      if (!disposed) {
        show(next.avatars.length === 0 ? null : next);
      }
    },
    clear() {
      if (!disposed) {
        show(null);
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      untrack?.();
      show(null);
      disposed = true;
      frame = null;
    },
  };
}
