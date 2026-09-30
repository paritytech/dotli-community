// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onSettled, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { unmountIslands } from '../../mount/islands.js';
import { topbarStore } from '../../state/topbar.js';
import {
  registerTopbarElement,
  revealTopbar,
  scheduleTopbarHide,
  SLIDE_TRANSITION,
  TOPBAR_REVEAL_SHORTCUT,
} from '../../topbar-autohide.js';
import { useStore } from '../use-store.js';
import { OfflineBanner } from './OfflineBanner.js';
import { TopbarActionsIsland } from './TopbarActionsIsland.js';
import { TopbarHome } from './TopbarHome.js';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * The host's top bar (`#topbar`), an island of the host page (see
 * islands.tsx): the home link, the URL bar, the account button and the
 * collapsible action group, and the offline banner under it. The URL bar and
 * the account button come in as slots (`url`, `account`), each an island of
 * its own that renders in the browser only (see apps/host/src/components/
 * Shell.astro).
 *
 * It slides as the topbar store says: out of view while the auto-hide
 * (topbar-autohide.ts) has hidden it, back on a hover, and it carries the
 * reveal shortcut while the auto-hide is on. The slide is a transform, with
 * no transition under reduced motion. The landing page has its own account
 * and theme buttons, so there the bar hides (`data-landing`, see
 * styles/topbar.css) and its actions go, the account button's island
 * unmounted with them.
 */
export function Topbar(props: { url?: JSX.Element; account?: JSX.Element }): JSX.Element {
  let bar: HTMLDivElement | undefined;
  const visible = useStore(topbarStore, state => state.visible);
  const autoHide = useStore(topbarStore, state => state.autoHide);
  const landing = useStore(topbarStore, state => state.landing);
  // Moving until mounted, as in the build-time render, which has no media.
  const [reducedMotion, setReducedMotion] = createSignal(false);

  onSettled(() => {
    const query = window.matchMedia(REDUCED_MOTION);
    const update = (): void => {
      setReducedMotion(query.matches);
    };
    update();
    query.addEventListener('change', update);
    const unregister = bar === undefined ? undefined : registerTopbarElement(bar);
    return () => {
      query.removeEventListener('change', update);
      unregister?.();
    };
  });

  return (
    <div
      ref={el => {
        bar = el;
        el.addEventListener('mouseenter', revealTopbar);
        el.addEventListener('mouseleave', scheduleTopbarHide);
      }}
      id="topbar"
      role="banner"
      aria-label="dot.li browser bar"
      aria-keyshortcuts={autoHide() ? TOPBAR_REVEAL_SHORTCUT : undefined}
      data-landing={landing() ? '' : undefined}
      style={{
        transform: visible() ? 'translateY(0)' : 'translateY(-100%)',
        transition: reducedMotion() ? 'none' : SLIDE_TRANSITION,
      }}
    >
      <TopbarHome />
      {props.url}
      <Show when={!landing()}>
        {(() => {
          // The account button is an island in the slot: unmount it with
          // the branch, its user popover (portaled into the body) and all.
          // In the browser only, where the slot is an element.
          onSettled(() => () => {
            if (props.account instanceof Element) {
              unmountIslands(props.account);
            }
          });
          return (
            <div class="topbar-right">
              {props.account}
              <TopbarActionsIsland />
            </div>
          );
        })()}
      </Show>
      <OfflineBanner />
    </div>
  );
}
