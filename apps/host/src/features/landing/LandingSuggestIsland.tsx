// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import { onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { useStore } from '@dotli/stores-solid';
import type { RecentLabels } from './createRecentLabels.js';
import { dotUrl } from './dotUrl.js';
import { getLandingRecentLabels } from './getLandingRecentLabels.js';
import { Suggestions } from './Suggestions.js';
import { landingNameList } from './landingNameList.js';
import { navComboboxState } from './navComboboxState.js';
import { useActiveTld, useRecents } from './landing.js';
import { LandingPartIsland } from './LandingPartIsland.js';
import { useSuggestions } from './useSuggestions.js';

/**
 * The names suggested under the landing page's name input: the recently visited ones, then those that publish an app.
 * The recents are written on the subdomain that resolved, so they load from the cross-subdomain store, not this
 * origin's localStorage. Astro hydrates it with no props, so the page's own store is the default.
 */
export function LandingSuggestIsland(props: { recents?: RecentLabels }): JSX.Element {
  return (
    <LandingPartIsland>
      <BoundSuggestions recents={props.recents} />
    </LandingPartIsland>
  );
}

// Inside the part, so a failure binding the list shows the error page as a failure rendering it does.
function BoundSuggestions(props: { recents: RecentLabels | undefined }): JSX.Element {
  const labels = useStore(landingNameList.labels);
  const syncing = useStore(landingNameList.syncing);
  const suffix = useActiveTld();
  const recents = useRecents(() => props.recents ?? getLandingRecentLabels(window));
  onSettled(() => {
    landingNameList.start();
  });
  const open = (label: string): void => {
    window.location.href = dotUrl(label);
  };
  const suggestions = useSuggestions({ labels, recents, loading: syncing, suffix, combobox: navComboboxState, open });
  return (
    <Suggestions
      recent={suggestions.recent}
      apps={suggestions.apps}
      loading={suggestions.loading}
      suffix={suffix}
      active={suggestions.active}
      onPick={open}
      onForget={recents.forget}
    />
  );
}
