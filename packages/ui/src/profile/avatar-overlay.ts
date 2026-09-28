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
 *
 * A contact reuses one reference across shares, so each placement also says
 * when the share arrived: a later share reloads the reference, and the old
 * profile stays drawn until the new one has loaded.
 */
export interface AvatarProfileCache {
  /** The settled profile; `null` when there is nothing to draw, `undefined` while unknown. */
  peek(reference: string): AvatarProfile | null | undefined;
  /** Load a reference once per share, however many overlays ask. */
  load(reference: string): Promise<void>;
  /** Note the share time of a placed reference; a later one makes it reload. */
  renew(reference: string, sharedAt: bigint): void;
  retain(reference: string): void;
  release(reference: string): void;
}

interface CacheEntry {
  users: number;
  value: AvatarProfile | null | undefined;
  loading: Promise<void> | null;
  aborter: AbortController;
  /** Latest share time seen; `null` before any placement names one. */
  sharedAt: bigint | null;
  /** A later share arrived after `value` was loaded. */
  stale: boolean;
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
        sharedAt: null,
        stale: false,
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
    aborter: AbortController,
    loaded: LoadedProfile | null,
  ): void => {
    // A newer share or an eviction superseded this load.
    if (entries.get(reference) !== entry || entry.aborter !== aborter) {
      return;
    }
    entry.loading = null;
    entry.stale = false;
    const bytes = loaded?.avatar ?? null;
    const type = bytes === null ? null : rasterImageType(bytes);
    const photoUrl =
      bytes === null || type === null
        ? null
        : URL.createObjectURL(
            new Blob([bytes as Uint8Array<ArrayBuffer>], { type }),
          );
    // The superseded photo is revoked only now, so it stays drawn until then.
    const previous = entry.value?.photoUrl;
    entry.value =
      loaded === null || (photoUrl === null && loaded.mood === undefined)
        ? null
        : { photoUrl, mood: loaded.mood };
    if (previous !== undefined && previous !== null) {
      URL.revokeObjectURL(previous);
    }
  };

  return {
    peek(reference) {
      return entries.get(reference)?.value;
    },
    load(reference) {
      const entry = entryFor(reference);
      if (entry.value !== undefined && !entry.stale) {
        return Promise.resolve();
      }
      if (entry.loading !== null) {
        return entry.loading;
      }
      const aborter = entry.aborter;
      let run: (signal: AbortSignal) => Promise<LoadedProfile>;
      try {
        run = loader(reference);
      } catch {
        // An unparseable reference draws nothing; the product is not told.
        settle(reference, entry, aborter, null);
        return Promise.resolve();
      }
      entry.loading = run(aborter.signal).then(
        (loaded) => {
          settle(reference, entry, aborter, loaded);
        },
        (error: unknown) => {
          // Name only: no error on this path carries the reference.
          log.debug(
            "[profile] contact avatar load failed:",
            error instanceof Error ? error.name : typeof error,
          );
          // A renewed share that fails to load keeps drawing the last one.
          if (entry.stale && entry.aborter === aborter) {
            entry.loading = null;
            entry.stale = false;
            return;
          }
          settle(reference, entry, aborter, null);
        },
      );
      return entry.loading;
    },
    renew(reference, sharedAt) {
      const entry = entryFor(reference);
      if (entry.sharedAt !== null && sharedAt <= entry.sharedAt) {
        return;
      }
      const first = entry.sharedAt === null;
      entry.sharedAt = sharedAt;
      if (first && entry.value === undefined) {
        return;
      }
      // Drop any load of the older share; the next `load` starts afresh.
      entry.aborter.abort();
      entry.aborter = new AbortController();
      entry.loading = null;
      entry.stale = entry.value !== undefined;
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

/** A CSS pixel box, relative to its parent. */
interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface SlotView {
  readonly root: HTMLElement;
  readonly anchor: HTMLElement;
  rootBox: Box | null;
  anchorBox: Box | null;
  /** Hidden until its position holds still. */
  moving: boolean;
  photo: HTMLElement | null;
  photoUrl: string | null;
  ring: MoodRingHandle | null;
  ringMood: Mood | null;
  ringPx: number;
}

/** Latest a timer can be armed for (setTimeout's signed 32-bit bound). */
const MAX_TIMER_MS = 2_147_483_647;

/** Shifts up to this are layout rounding, not motion. */
const MOTION_PX = 0.5;

/** How long positions must hold still before moved avatars show again. */
const SETTLE_MS = 150;

/** Class that hides a slot while it moves; the CSS fades it out and in. */
const MOVING_CLASS = "contact-avatar-moving";

function px(value: number): string {
  return `${String(value)}px`;
}

function sameBox(a: Box | null, b: Box): boolean {
  return (
    a !== null &&
    Math.abs(a.x - b.x) <= MOTION_PX &&
    Math.abs(a.y - b.y) <= MOTION_PX &&
    Math.abs(a.w - b.w) <= MOTION_PX &&
    Math.abs(a.h - b.h) <= MOTION_PX
  );
}

/** Write what changed of `next`; a transform moves it without layout. */
function writeBox(element: HTMLElement, previous: Box | null, next: Box): void {
  if (previous?.x !== next.x || previous.y !== next.y) {
    element.style.transform = `translate3d(${px(next.x)}, ${px(next.y)}, 0)`;
  }
  if (previous?.w !== next.w) {
    element.style.width = px(next.w);
  }
  if (previous?.h !== next.h) {
    element.style.height = px(next.h);
  }
}

function setMoving(view: SlotView, moving: boolean): void {
  if (view.moving !== moving) {
    view.moving = moving;
    view.root.classList.toggle(MOVING_CLASS, moving);
  }
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
  const waiting = new Map<string, Promise<void>>();
  let retained: readonly string[] = [];
  let placed: PlacedAvatars | null = null;
  let frame: HTMLIFrameElement | null = null;
  let fit: AvatarSurfaceFit = "viewport";
  let mirrored = "";
  let frameSize = "";
  let lapseTimer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let frameRequest: number | null = null;
  let untrack: (() => void) | null = null;
  let disposed = false;

  // The layer copies the frame's inline geometry (fixed box, topbar
  // transform and its transition), so it moves with the frame exactly.
  // Returns whether that geometry changed.
  const mirror = (): boolean => {
    if (frame === null || frame.style.cssText === mirrored) {
      return false;
    }
    mirrored = frame.style.cssText;
    layer.style.cssText = mirrored;
    layer.style.pointerEvents = "none";
    return true;
  };

  const stopSettle = (): void => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  };

  // Positions reach the host a few frames after the product drew them, so a
  // moving avatar would trail its row. Moved slots stay hidden until nothing
  // has moved for SETTLE_MS; every movement starts the wait again.
  const armSettle = (): void => {
    stopSettle();
    settleTimer = setTimeout(() => {
      settleTimer = null;
      for (const view of views.values()) {
        setMoving(view, false);
      }
    }, SETTLE_MS);
  };

  /** The frame itself moved: every avatar trails until the product re-places them. */
  const frameMoved = (): void => {
    if (views.size === 0) {
      return;
    }
    for (const view of views.values()) {
      setMoving(view, true);
    }
    armSettle();
  };

  const clearViews = (): void => {
    for (const view of views.values()) {
      stopView(view);
    }
    views.clear();
    stopSettle();
  };

  /** Draw one slot; returns whether it moved or first appeared. */
  const updateView = (
    slot: number,
    rect: AvatarRect,
    clip: { x0: number; y0: number; x1: number; y1: number },
    map: SurfaceMapping,
    profile: AvatarProfile,
    mood: Mood | undefined,
  ): boolean => {
    let view = views.get(slot);
    if (view === undefined) {
      const root = document.createElement("div");
      // A new slot starts hidden and fades in once positions settle.
      root.className = `contact-avatar-slot ${MOVING_CLASS}`;
      const anchor = document.createElement("div");
      anchor.className = "contact-avatar";
      root.appendChild(anchor);
      view = {
        root,
        anchor,
        rootBox: null,
        anchorBox: null,
        moving: true,
        photo: null,
        photoUrl: null,
        ring: null,
        ringMood: null,
        ringPx: 0,
      };
      views.set(slot, view);
    }
    if (view.root.parentNode !== layer) {
      layer.appendChild(view.root);
    }
    const width = rect.width * map.scaleX;
    const height = rect.height * map.scaleY;
    const rootBox: Box = {
      x: map.offsetX + clip.x0 * map.scaleX,
      y: map.offsetY + clip.y0 * map.scaleY,
      w: (clip.x1 - clip.x0) * map.scaleX,
      h: (clip.y1 - clip.y0) * map.scaleY,
    };
    const anchorBox: Box = {
      x: (rect.x - clip.x0) * map.scaleX,
      y: (rect.y - clip.y0) * map.scaleY,
      w: width,
      h: height,
    };
    const moved =
      !sameBox(view.rootBox, rootBox) || !sameBox(view.anchorBox, anchorBox);
    writeBox(view.root, view.rootBox, rootBox);
    writeBox(view.anchor, view.anchorBox, anchorBox);
    view.rootBox = rootBox;
    view.anchorBox = anchorBox;
    if (moved) {
      setMoving(view, true);
    }

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
    return moved;
  };

  /** Load `reference` if it is not already, and draw once it arrives. */
  const request = (reference: string): void => {
    // The cache hands back the same promise while one load runs; a renewed
    // share starts another, which is followed too.
    const loading = cache.load(reference);
    if (waiting.get(reference) === loading) {
      return;
    }
    waiting.set(reference, loading);
    // Draw into whatever placement is current once it arrives.
    void loading.then(() => {
      if (waiting.get(reference) === loading) {
        waiting.delete(reference);
      }
      schedule();
    });
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
    let moved = false;
    const drawn = new Set<number>();
    for (const avatar of current.avatars) {
      const profile = cache.peek(avatar.reference);
      if (profile === undefined) {
        request(avatar.reference);
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
      if (updateView(avatar.slot, rect, visible, map, profile, mood)) {
        moved = true;
      }
    }
    for (const [slot, view] of views) {
      if (!drawn.has(slot)) {
        stopView(view);
        views.delete(slot);
      }
    }
    if (views.size === 0) {
      stopSettle();
      layer.remove();
    } else {
      if (moved) {
        armSettle();
      }
      if (layer.previousElementSibling !== frame) {
        frame.after(layer);
      }
    }
    if (Number.isFinite(nextLapse)) {
      lapseTimer = setTimeout(
        schedule,
        Math.min(MAX_TIMER_MS, Math.max(0, (nextLapse - nowSecs) * 1000)),
      );
    }
  };

  // Placements can arrive faster than the screen redraws: draw only the
  // latest, once per animation frame.
  function schedule(): void {
    if (frameRequest === null && !disposed) {
      frameRequest = requestAnimationFrame(() => {
        frameRequest = null;
        render();
      });
    }
  }

  /** Draw now, dropping any pending frame, so removals are never late. */
  const flush = (): void => {
    if (frameRequest !== null) {
      cancelAnimationFrame(frameRequest);
      frameRequest = null;
    }
    render();
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
    if (next === null) {
      flush();
      return;
    }
    // A later share of a placed reference reloads it; loads start now rather
    // than at the next frame.
    for (const avatar of next.avatars) {
      cache.renew(avatar.reference, avatar.sharedAt);
      request(avatar.reference);
    }
    schedule();
  };

  return {
    attach(target, surfaceFit) {
      if (disposed) {
        return;
      }
      untrack?.();
      frame = target;
      fit = surfaceFit;
      mirrored = "";
      mirror();
      frameSize = `${String(target.clientWidth)}x${String(target.clientHeight)}`;
      const onStyle = (): void => {
        if (mirror()) {
          frameMoved();
          schedule();
        }
      };
      const onResize = (): void => {
        const size = `${String(target.clientWidth)}x${String(target.clientHeight)}`;
        if (size !== frameSize) {
          frameSize = size;
          frameMoved();
        }
        schedule();
      };
      const onWindowResize = (): void => {
        frameMoved();
        onResize();
      };
      const styleObserver = new MutationObserver(onStyle);
      styleObserver.observe(target, {
        attributes: true,
        attributeFilter: ["style"],
      });
      const resizeObserver =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(onResize);
      resizeObserver?.observe(target);
      window.addEventListener("resize", onWindowResize);
      untrack = () => {
        styleObserver.disconnect();
        resizeObserver?.disconnect();
        window.removeEventListener("resize", onWindowResize);
        untrack = null;
      };
      schedule();
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
