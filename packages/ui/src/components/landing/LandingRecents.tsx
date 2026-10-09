// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { LandingPart } from './LandingPart.js';
import { RecentList } from './RecentList.js';

export function LandingRecents(): JSX.Element {
  return (
    <LandingPart>
      <RecentList />
    </LandingPart>
  );
}
