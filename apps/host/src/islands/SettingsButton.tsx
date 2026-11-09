// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { getDotliVersion } from '../runtime/createTruapiRuntimeConfig.js';
import { themeState } from '../runtime/state/themeState.js';
import { SettingsItem } from '../components/settings/SettingsItem.js';
import { pageSettingsActions } from '../createSettingsActions.js';
import { isTruapiDebugEnabled, openInDebugMode } from '../debugMode.js';
import { settingsIntent } from '../createSettingsIntent.js';
import { settingsState } from '../state/settingsState.js';
import { pageTheme } from '../createThemeController.js';
import { useSettingsPanel } from './settings.js';

/**
 * The settings button and its popover, bound to the page's settings and theme.
 *
 * Saved settings come only from the settings state's store, which boot may seed after this island mounts. Never read
 * @dotli/config here, since boot's URL settings step must see the saved value first.
 */
export function SettingsButton(): JSX.Element {
  const panel = useSettingsPanel({
    settings: settingsState.store,
    theme: themeState.store,
    selectTheme: pageTheme.selectThemePref,
    apply: pageSettingsActions.applyAndReset,
    reset: pageSettingsActions.reset,
    registerOpener: settingsIntent.registerOpener,
    version: getDotliVersion(),
    debugMode: isTruapiDebugEnabled,
    openDebugMode: openInDebugMode,
  });
  return <SettingsItem {...panel} />;
}
