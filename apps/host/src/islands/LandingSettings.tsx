// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { useStore } from '@dotli/stores-solid';
import { LandingSettingsItem } from '../components/settings/LandingSettingsItem.js';
import { markAndReload } from '../createContinuation.js';
import { pageSettingsActions } from '../createSettingsActions.js';
import { landingNameList } from '../landingNameList.js';
import { getDotliVersion } from '../runtime/getDotliVersion.js';
import { settingsState } from '../state/settingsState.js';
import { LandingPart } from './LandingPart.js';

/** The landing page's settings button, bound to the page's settings and its name list. */
export function LandingSettings(): JSX.Element {
  return (
    <LandingPart>
      <BoundSettings />
    </LandingPart>
  );
}

// Inside the part, so a failure binding the settings shows the error page as a failure rendering them does.
function BoundSettings(): JSX.Element {
  return (
    <LandingSettingsItem
      settings={useStore(settingsState.store)}
      version={getDotliVersion()}
      onApply={pageSettingsActions.applyAndReset}
      reset={useStore(pageSettingsActions.reset, { initial: 'idle' })}
      onClearCache={clearCache}
    />
  );
}

/** Clears the name list, then reloads the page. The reload runs even when the clear failed, which the store reported. */
async function clearCache(): Promise<void> {
  await landingNameList.clear();
  markAndReload('settings_change');
}
