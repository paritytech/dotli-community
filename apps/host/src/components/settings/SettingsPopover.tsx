// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { SlidersIcon } from '@dotli/ui/icons';
import { IconButton, Popover, StatusDot } from '@dotli/ui';
import type { MoreRow } from '@dotli/ui';
import type { SavedSettings } from './settings.js';
import s from './SettingsPopover.module.css';

export interface SettingsPopoverProps {
  /** The page owns whether it is open, so a way into Settings from outside the bar can open it. */
  open: Accessor<boolean>;
  onOpenChange: (open: boolean) => void;
  /** Null until boot has read them. The button marks an unverified session. */
  settings: Accessor<SavedSettings | null>;
  /** Gets the button once it is on the page. */
  buttonRef?: ((button: HTMLButtonElement) => void) | undefined;
  /** The panel's body, which mounts with each opening. */
  children: JSX.Element;
  /** The body's chunk, which the popover loads while the browser is idle. */
  preload?: (() => Promise<unknown>) | undefined;
}

function unverified(settings: SavedSettings | null): boolean {
  return settings?.verified === false;
}

/** The settings button's More row, which carries the unverified mark while the session is unverified. */
export function settingsRow(props: Pick<SettingsPopoverProps, 'settings'>): MoreRow {
  return {
    label: 'Settings',
    icon: () => <SlidersIcon />,
    get aside() {
      return unverified(props.settings())
        ? () => <StatusDot tone="warn" size="sm" label="Unverified session" />
        : undefined;
    },
  };
}

/**
 * The settings button and its popover.
 *
 * Saved settings come only from `settings`, which boot may read after this mounts.
 */
export function SettingsPopover(props: SettingsPopoverProps): JSX.Element {
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  return (
    <>
      <IconButton
        ref={el => {
          setButton(el);
          props.buttonRef?.(el);
        }}
        id="mode-button"
        badge={unverified(props.settings())}
        title="Settings"
        aria-label="Settings"
      >
        <SlidersIcon />
      </IconButton>
      <Popover
        id="mode-popover"
        title="Settings"
        trigger={button()}
        open={props.open()}
        onOpenChange={props.onOpenChange}
        class={s['popover']}
        preload={props.preload}
      >
        {props.children}
      </Popover>
    </>
  );
}
