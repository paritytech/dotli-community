// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import { onSettled } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { useStore } from '@dotli/stores-solid';
import { dotUrl } from '../components/landing/dotUrl.js';
import { Suggestions } from '../components/landing/Suggestions.js';
import { landingNameList } from '../landingNameList.js';
import { navComboboxState } from '../state/navComboboxState.js';
import { useActiveTld } from './landing.js';
import { LandingPart } from './LandingPart.js';
import { useSuggestions } from './useSuggestions.js';

/** The names that publish an app, suggested under the landing page's name input. */
export function LandingSuggest(): JSX.Element {
  return (
    <LandingPart>
      <BoundSuggestions />
    </LandingPart>
  );
}

// Inside the part, so a failure binding the list shows the error page as a failure rendering it does.
function BoundSuggestions(): JSX.Element {
  const input = useStore(navComboboxState.input);
  const labels = useStore(landingNameList.labels);
  const suffix = useActiveTld();
  onSettled(() => {
    landingNameList.start();
  });
  const suggestions = useSuggestions({
    input,
    labels,
    suffix,
    combobox: navComboboxState,
    open: label => {
      window.location.href = dotUrl(label);
    },
  });
  return (
    <Suggestions labels={suggestions.shown} suffix={suffix} active={suggestions.active} onPick={suggestions.pick} />
  );
}
