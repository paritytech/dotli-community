// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The network button in the topbar: its place in the bar, its More row, its popover and the network panel it opens.

import { createSignal, lazy, untrack, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { GlobeIcon } from '@dotli/ui/icons';
import { ActionItem, IconButton, Popover, StatusDot } from '@dotli/ui';
import { loadChainsContent } from '../../lazy.js';
import { TOPBAR_PRIORITY } from '../topbar/priority.js';
import type { NetworkView } from './chains.js';
import type { ChainsContentProps } from './ChainsContent.js';
import { healthWord } from './network-health.js';
import s from './NetworkItem.module.css';

// Its own chunk, which the popover loads while the browser is idle.
const Chains = lazy(loadChainsContent, { export: 'ChainsContent' });

export interface NetworkItemProps extends Omit<ChainsContentProps, 'network'> {
  /**
   * Called as the panel opens, under the panel's owner, so the network is followed only while it shows. The network
   * changes with every chunk, speed sample and block.
   */
  followNetwork: () => Accessor<NetworkView>;
}

/** The panel's body, reading the network from its opening until it closes. */
function OpenChains(props: NetworkItemProps): JSX.Element {
  // Once per opening, as the body mounts with each one.
  const network = untrack(() => props.followNetwork());
  return <Chains network={network} health={props.health} productLoaded={props.productLoaded} backend={props.backend} />;
}

/** The network button and its popover. As a More row: the health in a word, and a warning raised on More. */
export function NetworkItem(props: NetworkItemProps): JSX.Element {
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  const settled = (): boolean => props.health() === 'ok' || props.health() === 'quiet';
  return (
    <ActionItem
      name="network"
      label="Network"
      icon={GlobeIcon}
      alert={
        settled() ? undefined : { tone: props.health(), label: `network ${healthWord(props.health()).toLowerCase()}` }
      }
      aside={() => (
        <>
          <StatusDot tone={props.health()} size="sm" pulse={props.health() === 'idle'} />
          <span>{healthWord(props.health())}</span>
        </>
      )}
      priority={TOPBAR_PRIORITY.network}
      activate={() => {
        button()?.click();
      }}
    >
      <IconButton
        ref={el => {
          setButton(el);
        }}
        id="chains-button"
        title="Network"
        aria-label="Network"
        badge
        badgeTone={props.health()}
      >
        <GlobeIcon />
      </IconButton>
      <Popover id="chains-popover" title="Network" trigger={button()} class={s['popover']} preload={Chains.preload}>
        <OpenChains {...props} />
      </Popover>
    </ActionItem>
  );
}
