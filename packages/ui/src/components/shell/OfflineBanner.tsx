// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { topbarStore } from '../../state/topbar.js';
import { useStore } from '../use-store.js';

/**
 * The topbar's offline banner (`#offline-banner`), a shell island (see
 * islands.tsx), the last child of `#topbar`: rendered with the host page,
 * hidden (online, as a build-time render has no navigator), then hydrated,
 * reading the connection once mounted. It shows while the browser reports
 * being offline and the topbar is visible, so it rides the topbar's auto-hide
 * instead of dangling into the viewport. As a PWA the host boots from the
 * service worker cache, so losing the connection is otherwise invisible.
 *
 * Not focusable and not clickable: it is a status live region only.
 */
export function OfflineBanner(): JSX.Element {
  const topbar = useStore(topbarStore);
  // Online until mounted, as in a build-time render, which has no navigator.
  const [online, setOnline] = createSignal(true);
  const update = (): void => {
    setOnline(navigator.onLine);
  };
  onSettled(() => {
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  });

  return (
    <div
      id="offline-banner"
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute',
        top: '100%',
        left: '0',
        right: '0',
        'z-index': '999',
        background: '#b45309',
        color: '#fff',
        'font-size': '0.75rem',
        'font-weight': '500',
        'text-align': 'center',
        padding: '4px 12px',
        'letter-spacing': '0.02em',
        display: !online() && topbar().visible ? 'block' : 'none',
      }}
    >
      You are offline
    </div>
  );
}
