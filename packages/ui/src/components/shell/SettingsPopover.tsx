// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, lazy, onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { SLIDERS_PATH } from '../../settings-glyph.js';
import { settingsStore } from '../../state/settings.js';
import { setSettingsOpen, topbarStore } from '../../state/topbar.js';
import { Popover } from '../floating/Popover.js';
import { IconButton } from '../primitives/IconButton.js';
import { StatusDot } from '../primitives/StatusDot.js';
import { useStore } from '../use-store.js';
import { TOPBAR_PRIORITY } from './topbar/fit.js';
import { TopbarItem } from './topbar/TopbarItem.js';
import s from './SettingsPopover.module.css';

const Settings = lazy(() => import('./SettingsContent.js'), { export: 'SettingsContent' });

function SlidersIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d={SLIDERS_PATH} />
    </svg>
  );
}

/**
 * The settings button and its popover.
 *
 * SettingsContent is its own chunk. Network, transport, cache and runtime settings stay a draft across categories
 * until Save and apply; closing discards them. Theme and background receiving controls apply immediately.
 *
 * Saved settings come only from settingsStore, which boot may seed after this island mounts. Never read
 * @dotli/config here: a read can rewrite a setting (getBackend drops a shared worker choice the browser
 * cannot run), and boot's URL settings step must see the saved value first.
 */
export function SettingsPopover(): JSX.Element {
  const settings = useStore(settingsStore);
  const open = useStore(topbarStore, state => state.settingsOpen);
  // Gone with the panel: a later openSettings() opens it again.
  onCleanup(() => {
    setSettingsOpen(false);
  });
  const [button, setButton] = createSignal<HTMLButtonElement | undefined>(undefined, { ownedWrite: true });
  return (
    <>
      <TopbarItem
        name="settings"
        label="Settings"
        icon={SlidersIcon}
        aside={
          settings()?.verified === false
            ? () => <StatusDot tone="warn" size="sm" label="Unverified session" />
            : undefined
        }
        priority={TOPBAR_PRIORITY.settings}
        activate={() => button()?.click()}
      >
        <IconButton
          ref={setButton}
          id="mode-button"
          badge={settings()?.verified === false}
          title="Settings"
          aria-label="Settings"
        >
          <SlidersIcon />
        </IconButton>
      </TopbarItem>
      <Popover
        id="mode-popover"
        title="Settings"
        trigger={button()}
        open={open()}
        onOpenChange={setSettingsOpen}
        class={s['popover']}
        preload={Settings.preload}
      >
        <Settings />
      </Popover>
    </>
  );
}
