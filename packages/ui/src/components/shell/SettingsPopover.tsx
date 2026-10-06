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

/** The popover's body, its own chunk. */
const Settings = lazy(() => import('./SettingsContent.js'), { export: 'SettingsContent' });

/** The board's settings sliders, on the button and the More menu row. */
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
 * The settings button (`#mode-button`) and its popover (`#mode-popover`, a
 * floating Popover), an item of the topbar's action group island (see
 * src/islands/), rendered with the host page and hydrated.
 *
 * The popover's body, SettingsContent, is its own chunk: the network and
 * transport choices, the cache switches, "Clear all caches" and the
 * diagnostics. Changes stay a draft until Save and apply, which saves them and
 * reloads (settings-actions.ts); each opening starts from the saved
 * settings. The button carries its badge (`data-badge`) while the session is
 * not verified (trusted providers).
 *
 * The saved settings come only from settingsStore, which the host seeds at
 * boot, possibly after this island mounted: until then the button shows no
 * mark and the popover nothing, and an opening under way when the store is
 * seeded fills in then. The island never reads @dotli/config itself,
 * because reading can rewrite a setting (getBackend drops a shared worker
 * choice the browser cannot run), and the boot's URL settings step must see
 * the saved value first.
 *
 * On a wide screen it is a non-modal popover, Tab looping inside it; on a
 * phone it is a modal bottom sheet, with a header and a close button. It
 * closes as every Popover does (floating/Popover.tsx). The topbar store's
 * `settingsOpen` follows it, and openSettings() (an error page's "Open
 * settings") opens it through that. The More menu's Settings row opens it
 * while the topbar has collapsed the button.
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
