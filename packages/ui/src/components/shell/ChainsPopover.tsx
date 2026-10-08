// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, lazy } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { networkHealthStore } from '../../state/network-health.js';
import { healthWord } from '../../network-health.js';
import { Popover } from '../floating/Popover.js';
import { IconButton } from '../primitives/IconButton.js';
import { StatusDot } from '../primitives/StatusDot.js';
import { useStore } from '../use-store.js';
import { TOPBAR_PRIORITY } from './topbar/fit.js';
import { TopbarItem } from './topbar/TopbarItem.js';
import s from './ChainsPopover.module.css';

const Chains = lazy(() => import('./ChainsContent.js'), { export: 'ChainsContent' });

function GlobeIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

/** The network button and its popover. */
export function ChainsPopover(): JSX.Element {
  const health = useStore(networkHealthStore);
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  return (
    <>
      <TopbarItem
        name="network"
        label="Network"
        icon={GlobeIcon}
        alert={
          health() === 'ok' || health() === 'quiet'
            ? undefined
            : { tone: health(), label: `network ${healthWord(health()).toLowerCase()}` }
        }
        aside={() => (
          <>
            <StatusDot tone={health()} size="sm" pulse={health() === 'idle'} />
            <span>{healthWord(health())}</span>
          </>
        )}
        priority={TOPBAR_PRIORITY.network}
        activate={() => button()?.click()}
      >
        <IconButton ref={setButton} id="chains-button" title="Network" aria-label="Network" badge badgeTone={health()}>
          <GlobeIcon />
        </IconButton>
      </TopbarItem>
      <Popover id="chains-popover" title="Network" trigger={button()} class={s['popover']} preload={Chains.preload}>
        <Chains />
      </Popover>
    </>
  );
}
