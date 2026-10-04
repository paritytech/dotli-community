// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { lazy, onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { settingsStore } from '../../state/settings.js';
import { setSettingsOpen, topbarStore } from '../../state/topbar.js';
import { useStore } from '../use-store.js';
import { Popover } from './Popover.js';
import { TOPBAR_PRIORITY } from './topbar/fit.js';
import { TopbarItem } from './topbar/TopbarItem.js';

/** The popover's body, its own chunk. */
const Settings = lazy(() => import('./SettingsContent.js'), { export: 'SettingsContent' });

const SETTINGS_ICON_PATH =
  'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z';

/** The settings gear, on the button and the More menu row. */
function GearIcon(props: { size: number }): JSX.Element {
  return (
    <svg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d={SETTINGS_ICON_PATH} />
    </svg>
  );
}

/**
 * The settings button (`#mode-button`), its popover (`#mode-popover`, a
 * Popover with a backdrop, in the body) and the popover's backdrop, an item
 * of the topbar's action group island (see src/islands/), rendered with the
 * host page and hydrated.
 *
 * The popover's body, SettingsContent, is its own chunk: the network and
 * transport choices, the cache switches, "Clear all caches" and the
 * diagnostics. Network, transport, cache and runtime changes stay a draft
 * until Save & Apply, which saves them and reloads (settings-actions.ts);
 * receiving controls apply immediately. Each opening starts from the saved
 * settings. The button carries `.gateway-mode` while the session is not
 * verified (trusted providers).
 *
 * The saved settings come only from settingsStore, which the host seeds at
 * boot, possibly after this island mounted: until then the button shows no
 * mark and the popover nothing, and an opening under way when the store is
 * seeded fills in then. The island never reads @dotli/config itself,
 * because reading can rewrite a setting (getBackend drops a shared worker
 * choice the browser cannot run), and the boot's URL settings step must see
 * the saved value first.
 *
 * On a wide screen it is a non-modal popover: Tab loops inside it, and a
 * press outside (the backdrop included), focus moved out, Escape and a
 * blocking modal close it. On a phone it is a modal bottom sheet, with a
 * header and a close button. The topbar store's `settingsOpen` follows it,
 * and openSettings() (an error page's "Open settings") opens it through
 * that. The More menu's Settings row opens it while the topbar has
 * collapsed the button.
 */
export function SettingsPopover(): JSX.Element {
  const settings = useStore(settingsStore);
  const open = useStore(topbarStore, state => state.settingsOpen);
  // Gone with the panel: a later openSettings() opens it again.
  onCleanup(() => {
    setSettingsOpen(false);
  });
  return (
    <Popover
      id="mode-popover"
      title="Settings"
      class="mode-popover"
      backdrop
      content={Settings}
      open={open()}
      onOpenChange={setSettingsOpen}
      trigger={t => (
        <TopbarItem
          name="settings"
          label="Settings"
          icon={() => <GearIcon size={14} />}
          priority={TOPBAR_PRIORITY.settings}
          activate={t.onClick}
        >
          <button
            {...t}
            id="mode-button"
            class={settings()?.verified === false ? 'topbar-btn gateway-mode' : 'topbar-btn'}
            title="Settings"
            aria-label="Settings"
          >
            <GearIcon size={12} />
          </button>
        </TopbarItem>
      )}
    />
  );
}
