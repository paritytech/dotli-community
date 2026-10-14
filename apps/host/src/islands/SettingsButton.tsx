// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { dotliVersion } from '../runtime/runtime-config.js';
import { themeStore } from '../runtime/state/theme.js';
import { SettingsItem } from '../components/settings/SettingsItem.js';
import { isTruapiDebugEnabled, openInDebugMode, pageSettingsActions } from '../settings-actions.js';
import { registerSettingsOpener } from '../settings-intent.js';
import { settingsStore } from '../state/settings.js';
import { selectThemePref } from '../theme-controller.js';
import { useSettingsPanel } from './settings.js';

/**
 * The settings button and its popover, bound to the page's settings and theme.
 *
 * Saved settings come only from settingsStore, which boot may seed after this island mounts. Never read
 * @dotli/config here, since boot's URL settings step must see the saved value first.
 */
export function SettingsButton(): JSX.Element {
  const panel = useSettingsPanel({
    settings: settingsStore,
    theme: themeStore,
    selectTheme: selectThemePref,
    apply: pageSettingsActions.applyAndReset,
    registerOpener: registerSettingsOpener,
    version: dotliVersion(),
    debugMode: isTruapiDebugEnabled,
    openDebugMode: openInDebugMode,
  });
  return <SettingsItem {...panel} />;
}
