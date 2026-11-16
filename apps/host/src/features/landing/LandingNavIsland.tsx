// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { useStore } from '@dotli/stores-solid';
import { NavForm } from './NavForm.js';
import { readLandingName } from '../../kit/getLandingUrl.js';
import { navComboboxState } from './navComboboxState.js';
import { useActiveTld } from './landing.js';
import { LandingPartIsland } from './LandingPartIsland.js';

/** The landing page's name form, under the visitor's network's TLD. */
export function LandingNavIsland(): JSX.Element {
  return (
    <LandingPartIsland>
      <BoundNavForm />
    </LandingPartIsland>
  );
}

// Inside the part, so a failure binding the form shows the error page as a failure rendering it does.
function BoundNavForm(): JSX.Element {
  const suffix = useActiveTld();
  const listbox = useStore(navComboboxState.listbox);
  return (
    <NavForm
      suffix={suffix}
      listbox={listbox}
      combobox={navComboboxState}
      readInitialName={() => readLandingName(window.location.search)}
    />
  );
}
