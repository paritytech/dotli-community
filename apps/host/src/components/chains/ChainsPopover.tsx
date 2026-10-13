// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { GlobeIcon } from '@dotli/ui/icons';
import { IconButton, Popover, StatusDot } from '@dotli/ui';
import type { MoreRow } from '@dotli/ui';
import { healthWord, type NetworkHealth } from './network-health.js';
import s from './ChainsPopover.module.css';

export interface ChainsPopoverProps {
  /** The badge's tone. */
  health: Accessor<NetworkHealth>;
  /** Gets the button once it is on the page. */
  buttonRef?: ((button: HTMLButtonElement) => void) | undefined;
  /** The panel's body, which mounts with each opening. */
  children: JSX.Element;
  /** The body's chunk, which the popover loads while the browser is idle. */
  preload?: (() => Promise<unknown>) | undefined;
}

/** The network button's More row: the health in a word, and a warning raised on More. */
export function networkRow(props: Pick<ChainsPopoverProps, 'health'>): MoreRow {
  return {
    label: 'Network',
    icon: () => <GlobeIcon />,
    get alert(): MoreRow['alert'] {
      return props.health() === 'ok' || props.health() === 'quiet'
        ? undefined
        : { tone: props.health(), label: `network ${healthWord(props.health()).toLowerCase()}` };
    },
    aside: () => (
      <>
        <StatusDot tone={props.health()} size="sm" pulse={props.health() === 'idle'} />
        <span>{healthWord(props.health())}</span>
      </>
    ),
  };
}

/** The network button and its popover. */
export function ChainsPopover(props: ChainsPopoverProps): JSX.Element {
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  return (
    <>
      <IconButton
        ref={el => {
          setButton(el);
          props.buttonRef?.(el);
        }}
        id="chains-button"
        title="Network"
        aria-label="Network"
        badge
        badgeTone={props.health()}
      >
        <GlobeIcon />
      </IconButton>
      <Popover id="chains-popover" title="Network" trigger={button()} class={s['popover']} preload={props.preload}>
        {props.children}
      </Popover>
    </>
  );
}
