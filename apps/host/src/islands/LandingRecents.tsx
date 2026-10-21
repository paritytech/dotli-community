// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// One module per island, so Astro loads only this island's code when its directive fires.

import type { JSX } from '@solidjs/web';
import { landingRecentLabels, type RecentLabels } from '../recent-labels.js';
import { RecentList } from '../components/landing/RecentList.js';
import { useActiveTld, useRecents } from './landing.js';
import { LandingPart } from './LandingPart.js';

/**
 * The landing page's recently visited names. They are written on the subdomain that resolved, so they load from the
 * cross-subdomain store, not this origin's localStorage. Astro hydrates it with no props, so the page's own store is
 * the default.
 */
export function LandingRecents(props: { recents?: RecentLabels }): JSX.Element {
  return (
    <LandingPart>
      <BoundRecentList recents={props.recents} />
    </LandingPart>
  );
}

// Inside the part, so a failure binding the list shows the error page as a failure rendering it does.
function BoundRecentList(props: { recents: RecentLabels | undefined }): JSX.Element {
  const suffix = useActiveTld();
  const recents = useRecents(() => props.recents ?? landingRecentLabels(window));
  return <RecentList labels={recents.labels} suffix={suffix} onForget={recents.forget} />;
}
