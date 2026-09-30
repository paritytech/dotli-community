// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createMemo } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { loadingStore } from '../../state/loading.js';
import { useStore } from '../use-store.js';

/**
 * The loading screen (`#app-loading`), an island (see src/islands/) the host
 * page paints first and hydrates. It renders the loading store, which
 * loading-controller.ts writes, so progress made before it hydrates shows
 * once it has. It fades while the screen is dismissed. Removing it is the `"loading"` app root's job.
 * The petals cycle in CSS (styles/base.css).
 */
export function LoadingScreen(): JSX.Element {
  // One selector per field, so a line is only written when it changes:
  // writing an unchanged live region could make a screen reader announce it
  // again.
  const progress = useStore(loadingStore, s => s.progress);
  const shown = createMemo(() => Math.round(progress()));
  const statusText = useStore(loadingStore, s => s.statusText);
  const statusOpacity = useStore(loadingStore, s => s.statusOpacity);
  const srText = useStore(loadingStore, s => s.srText);
  const warning = useStore(loadingStore, s => s.warning);
  const dismissing = useStore(loadingStore, s => s.phase === 'dismissing');

  return (
    <div
      class="loading"
      id="app-loading"
      style={
        dismissing()
          ? {
              transition: 'opacity 0.3s ease',
              opacity: '0',
              'pointer-events': 'none',
            }
          : undefined
      }
    >
      <div class="loading-logo" id="loading-logo">
        <svg width="120" height="120" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            class="loading-petal"
            d="M31.0155 57.7181C14.6547 76.7768 14.2233 103.306 30.0862 116.92C45.9492 130.566 72.0667 126.15 88.4607 107.058C104.821 87.9995 105.253 61.4701 89.3899 47.8567C83.1841 42.511 75.3522 39.9543 67.1884 39.9543C54.5113 39.9543 40.9713 46.1302 31.0155 57.7181Z"
          />
          <path
            class="loading-petal"
            d="M26.2694 156.332C13.9574 170.941 19.3003 195.744 38.2164 211.715C57.1326 227.686 82.4868 228.815 94.7989 214.205C107.111 199.596 101.768 174.793 82.8518 158.822C72.8296 150.355 61.0153 146.072 50.2962 146.072C40.7718 146.072 32.077 149.459 26.3026 156.332"
          />
          <path
            class="loading-petal"
            d="M137.343 209.789C115.142 216.795 99.8429 231.072 103.161 241.664C106.513 252.256 127.221 255.178 149.423 248.139C171.625 241.133 186.923 226.856 183.605 216.264C181.481 209.59 172.454 205.938 160.507 205.938C153.505 205.938 145.54 207.166 137.343 209.756"
          />
          <path
            class="loading-petal"
            d="M102.597 18.5365C98.0176 31.7514 112.553 48.8179 135.12 56.6871C157.686 64.5562 179.689 60.2066 184.268 46.9917C188.848 33.7768 174.313 16.7103 151.746 8.84109C144.146 6.18482 136.58 4.9231 129.744 4.9231C116.303 4.9231 105.617 9.77078 102.597 18.5365Z"
          />
          <path
            class="loading-petal"
            d="M204.048 45.169C197.51 47.7921 199.07 66.884 207.499 87.7357C215.928 108.621 228.041 123.396 234.579 120.773C241.083 118.15 239.557 99.0912 231.128 78.2063C223.362 58.9484 212.444 44.8702 205.674 44.8702C205.11 44.8702 204.579 44.9698 204.048 45.169Z"
          />
          <path
            class="loading-petal"
            d="M209.058 172.038C199.766 192.192 196.547 210.553 201.89 213.01C207.233 215.468 219.114 201.124 228.406 180.969C237.731 160.815 240.917 142.453 235.607 139.996C235.209 139.797 234.778 139.731 234.28 139.731C228.472 139.731 217.654 153.411 209.058 172.038Z"
          />
        </svg>
      </div>
      <div
        class="loading-progress"
        id="loading-progress"
        role="progressbar"
        aria-label="Loading"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={String(shown())}
      >
        <div class="loading-progress-bar">
          <div class="loading-progress-fill" id="loading-progress-fill" style={{ width: `${String(progress())}%` }} />
        </div>
        <span class="loading-progress-pct" id="loading-progress-pct">
          {`${String(shown())}%`}
        </span>
      </div>
      <div class="loading-text" id="loading-text">
        <div class="loading-status" id="loading-status">
          {/* Typed a character at a time, so hidden from screen readers,
              which get whole sentences from the element below. */}
          <p id="status" aria-hidden="true" style={{ opacity: String(statusOpacity()) }}>
            {statusText()}
          </p>
          <p class="sr-only" id="status-sr" aria-live="polite">
            {srText()}
          </p>
          <p class={['loading-warning', { visible: warning() !== null }]} id="loading-warning" role="status">
            <svg
              class="loading-warning-icon"
              viewBox="0 0 16 16"
              aria-hidden="true"
              // @ts-expect-error -- not in Solid's SVG types, but hides the icon from focus
              focusable="false"
            >
              <path
                d="M8 1.6 15 14H1L8 1.6Z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linejoin="round"
              />
              <path d="M8 6v3.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              <circle cx="8" cy="11.8" r="0.85" fill="currentColor" />
            </svg>
            <span id="loading-warning-text">{warning() ?? ''}</span>
          </p>
        </div>
      </div>
    </div>
  );
}
