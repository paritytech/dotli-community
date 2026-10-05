// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { lazy } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { networkHealthStore } from '../../state/network-health.js';
import { healthWord } from '../../network-health.js';
import { topbarStore } from '../../state/topbar.js';
import { IconButton } from '../primitives/IconButton.js';
import { StatusDot } from '../primitives/StatusDot.js';
import { useStore } from '../use-store.js';
import { Popover } from './Popover.js';
import { TOPBAR_PRIORITY } from './topbar/fit.js';
import { TopbarItem } from './topbar/TopbarItem.js';
import s from './ChainsPopover.module.css';

/** The popover's body, its own chunk. */
const Chains = lazy(() => import('./ChainsContent.js'), { export: 'ChainsContent' });

/** The network globe, on the button and the More menu row. */
function GlobeIcon(props: { size: number; stroke?: number }): JSX.Element {
  return (
    <svg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={props.stroke ?? 2}
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

/**
 * The network button (`#chains-button`) and its popover (`#chains-popover`,
 * a Popover in the body; a bottom sheet on phones), an item of the topbar's
 * action group island (see src/islands/), rendered with the host page and
 * hydrated.
 *
 * The button shows once the host has a product on screen (topbarStore's
 * `chainsButtonVisible`, which setChainsButtonVisible in topbar.ts writes).
 * Collapsed into More, its row ends with the health's dot and word, and while
 * the health is not ok More carries its badge and names the verdict.
 * The popover's body, ChainsContent, is its own chunk: a head with the
 * network chip, a status well with the overall verdict, a strip of block
 * bars and the peer count per chain, the download while the product is
 * loading, and tips, with every chain's block arrivals watched while it is
 * mounted. A content failure is reported as `popover:chains-popover` and
 * closes it, and the next opening renders it afresh.
 *
 * A press outside, focus leaving it, Escape and a blocking modal close the
 * popover, a non-modal one.
 */
export function ChainsPopover(): JSX.Element {
  const topbar = useStore(topbarStore);
  const health = useStore(networkHealthStore);
  return (
    <Popover
      id="chains-popover"
      title="Network"
      class={s['popover']}
      content={Chains}
      trigger={t => (
        <TopbarItem
          name="network"
          label="Network"
          icon={() => <GlobeIcon size={14} />}
          alert={
            health() === 'ok' ? undefined : { tone: health(), label: `network ${healthWord(health()).toLowerCase()}` }
          }
          aside={() => (
            <>
              <StatusDot tone={health()} size="sm" pulse={health() === 'idle'} />
              <span>{healthWord(health())}</span>
            </>
          )}
          priority={TOPBAR_PRIORITY.network}
          visible={topbar().chainsButtonVisible}
          activate={t.onClick}
        >
          <IconButton {...t} id="chains-button" title="Network" aria-label="Network" badge badgeTone={health()}>
            <GlobeIcon size={20} stroke={1.75} />
          </IconButton>
        </TopbarItem>
      )}
    />
  );
}
