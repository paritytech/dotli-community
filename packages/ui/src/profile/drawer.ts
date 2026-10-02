// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Host-owned profile drawer, rendered by the Solid overlay surface.
//
// A product asks the host to show a profile it holds a reference to; the host
// fetches and decrypts it and renders it here, so the image never enters the
// product. Without a received reference it shows an empty state immediately;
// otherwise it loads the avatar and mood. It asks nothing, and presenting
// another profile replaces the one on screen.

import { createComponent } from 'solid-js';
import { mountRoot } from '../mount/root.js';
import { ensureOverlayRoot } from '../mount/overlay-root.js';
import type { Mood } from './profile-record.js';

/** What a reference opened to. Either half may be missing. */
export interface LoadedProfile {
  readonly avatar: Uint8Array | null;
  readonly mood?: Mood;
}

export interface ProfileDrawerOptions {
  /** Product that asked for the presentation, shown as attribution. */
  readonly productId: string;
  /**
   * The contact's host-verified username, or a generic phrase when unknown.
   * Never an address or a product-supplied name.
   */
  readonly contactName?: string;
  /** Fetch and decrypt a received profile; absent when no reference was shared. */
  readonly loadProfile?: (signal: AbortSignal) => Promise<LoadedProfile>;
  /** The product connection owns this presentation's lifetime. */
  readonly signal?: AbortSignal;
}

export interface ProfileDrawerHandle {
  readonly close: () => void;
}

let current: ProfileDrawerHandle | null = null;

/**
 * Raster formats a profile image may use. Anything else, SVG included, is
 * refused rather than handed to the renderer.
 */
export function rasterImageType(bytes: Uint8Array): string | null {
  const starts = (...prefix: number[]): boolean => prefix.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png';
  }
  if (starts(0xff, 0xd8, 0xff)) {
    return 'image/jpeg';
  }
  if (starts(0x47, 0x49, 0x46, 0x38)) {
    return 'image/gif';
  }
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export async function showProfileDrawer(options: ProfileDrawerOptions): Promise<ProfileDrawerHandle> {
  options.signal?.throwIfAborted();
  current?.close();
  const aborter = new AbortController();
  let dispose: (() => void) | undefined;
  const handle: ProfileDrawerHandle = {
    close() {
      aborter.abort();
      options.signal?.removeEventListener('abort', handle.close);
      dispose?.();
      if (current === handle) {
        current = null;
      }
    },
  };
  current = handle;
  options.signal?.addEventListener('abort', handle.close, { once: true });
  try {
    // Keep profile presentation off the startup path, as with the other host overlays.
    const { ProfileDrawer } = await import('../components/overlays/ProfileDrawer.js');
    aborter.signal.throwIfAborted();
    const container = document.createElement('div');
    ensureOverlayRoot().appendChild(container);
    dispose = mountRoot(
      'profile-drawer',
      container,
      () =>
        createComponent(ProfileDrawer, {
          options,
          signal: aborter.signal,
          onClose: handle.close,
        }),
      { removeContainer: true, onBroken: handle.close },
    );
    return handle;
  } catch (error) {
    handle.close();
    throw error;
  }
}
