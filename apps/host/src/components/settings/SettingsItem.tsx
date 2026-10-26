// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The settings button in the topbar: its place in the bar, its More row, its popover and the panel it opens.

import { createSignal, lazy, type Accessor } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { SlidersIcon } from '@dotli/ui/icons';
import { ActionItem, IconButton, Popover, StatusDot } from '@dotli/ui';
import { loadSettingsContent } from '../../lazy.js';
import { TOPBAR_PRIORITY } from '../topbar/priority.js';
import type { SavedSettings } from './settings.js';
import type { SettingsContentProps } from './SettingsContent.js';
import s from './SettingsItem.module.css';

// Its own chunk, which the popover loads while the browser is idle.
const Settings = lazy(loadSettingsContent, { export: 'SettingsContent' });

export type SettingsItemProps = {
  /** The page owns whether it is open, so a way into Settings from outside the bar can open it. */
  open: Accessor<boolean>;
  onOpenChange: (open: boolean) => void;
} & SettingsContentProps;

function unverified(settings: SavedSettings | null): boolean {
  return settings?.verified === false;
}

/**
 * The settings button and its popover. Its More row carries the unverified mark while the session is unverified.
 *
 * Saved settings come only from `settings`, which boot may read after this mounts.
 */
export function SettingsItem(props: SettingsItemProps): JSX.Element {
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  return (
    <ActionItem
      name="settings"
      label="Settings"
      icon={SlidersIcon}
      aside={
        unverified(props.settings()) ? () => <StatusDot tone="warn" size="sm" label="Unverified session" /> : undefined
      }
      priority={TOPBAR_PRIORITY.settings}
      activate={() => {
        button()?.click();
      }}
    >
      <IconButton
        ref={el => {
          setButton(el);
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
        preload={Settings.preload}
      >
        <Settings
          settings={props.settings}
          version={props.version}
          theme={props.theme}
          onTheme={props.onTheme}
          onApply={props.onApply}
          debugMode={props.debugMode}
          onDebugMode={props.onDebugMode}
        />
      </Popover>
    </ActionItem>
  );
}
