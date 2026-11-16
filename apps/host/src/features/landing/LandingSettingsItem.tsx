// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page's settings button: its popover and the panel it opens.

import { createSignal, lazy } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { SlidersIcon } from '@dotli/ui/icons';
import { IconButton, Popover } from '@dotli/ui';
import type { LandingSettingsContentProps } from './LandingSettingsContent.js';
import s from './LandingSettingsItem.module.css';

// Its own chunk, which the popover loads while the browser is idle.
const Settings = lazy(() => import('./LandingSettingsContent.js'), { export: 'LandingSettingsContent' });

export type LandingSettingsItemProps = LandingSettingsContentProps;

/** The landing page's settings button and its popover. */
export function LandingSettingsItem(props: LandingSettingsItemProps): JSX.Element {
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  return (
    <>
      <IconButton
        ref={el => {
          setButton(el);
        }}
        id="landing-settings-button"
        title="Settings"
        aria-label="Settings"
      >
        <SlidersIcon />
      </IconButton>
      <Popover
        id="landing-settings-popover"
        title="Settings"
        trigger={button()}
        class={s['popover']}
        preload={Settings.preload}
      >
        <Settings {...props} />
      </Popover>
    </>
  );
}
