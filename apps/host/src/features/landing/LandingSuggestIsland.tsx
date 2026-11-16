// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import { onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { useStore } from '@dotli/stores-solid';
import { dotUrl } from './dotUrl.js';
import { Suggestions } from './Suggestions.js';
import { landingNameList } from './landingNameList.js';
import { navComboboxState } from './navComboboxState.js';
import { useActiveTld } from './landing.js';
import { LandingPartIsland } from './LandingPartIsland.js';
import { useSuggestions } from './useSuggestions.js';

/** The names that publish an app, suggested under the landing page's name input. */
export function LandingSuggestIsland(): JSX.Element {
  return (
    <LandingPartIsland>
      <BoundSuggestions />
    </LandingPartIsland>
  );
}

// Inside the part, so a failure binding the list shows the error page as a failure rendering it does.
function BoundSuggestions(): JSX.Element {
  const labels = useStore(landingNameList.labels);
  const syncing = useStore(landingNameList.syncing);
  const suffix = useActiveTld();
  onSettled(() => {
    landingNameList.start();
  });
  const open = (label: string): void => {
    window.location.href = dotUrl(label);
  };
  const suggestions = useSuggestions({ labels, loading: syncing, suffix, combobox: navComboboxState, open });
  return (
    <Suggestions
      labels={suggestions.shown}
      loading={suggestions.loading}
      suffix={suffix}
      active={suggestions.active}
      onPick={open}
    />
  );
}
