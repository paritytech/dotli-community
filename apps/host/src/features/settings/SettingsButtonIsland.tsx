// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { getDotliVersion } from '../../kit/getDotliVersion.js';
import { themeState } from './themeState.js';
import { SettingsItem } from './SettingsItem.js';
import { pageSettingsActions } from './createSettingsActions.js';
import { isTruapiDebugEnabled, openInDebugMode } from '../debug/index.js';
import { settingsIntent } from './createSettingsIntent.js';
import { settingsState } from './settingsState.js';
import { pageTheme } from './createThemeController.js';
import { useSettingsPanel } from './useSettingsPanel.js';

/**
 * The settings button and its popover, bound to the page's settings and theme.
 *
 * Saved settings come only from the settings state's store, which boot may seed after this island mounts. Never read
 * @dotli/config here, since boot's URL settings step must see the saved value first.
 */
export function SettingsButtonIsland(): JSX.Element {
  const panel = useSettingsPanel({
    settings: settingsState.store,
    theme: themeState.store,
    selectTheme: pageTheme.selectThemePref,
    actions: pageSettingsActions,
    intent: settingsIntent,
    version: getDotliVersion(),
    debugMode: isTruapiDebugEnabled,
    openDebugMode: openInDebugMode,
  });
  return <SettingsItem {...panel} />;
}
