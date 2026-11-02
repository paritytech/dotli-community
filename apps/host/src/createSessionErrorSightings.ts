// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sightings that let a failure a reload did not fix offer more.

import { pageSessionStorage, type SafeStorage } from '@dotli/shared';
import type { ErrorSightings } from './presentLoadFailure.js';

type Params = {
  /** The tab's session storage, which never throws. */
  session: Pick<SafeStorage, 'getItem' | 'setItem' | 'removeItem'>;
};

const ERROR_SEEN_KEY = 'dotli:error-seen';

/**
 * Not consumed on read, and cleared on success, so a sighting means "this reload did not help". Without storage every
 * failure is a first sighting, which keeps the gentler screen.
 */
export function createSessionErrorSightings({ session }: Params): ErrorSightings & { forget: () => void } {
  return {
    hasSeen(kind) {
      return session.getItem(ERROR_SEEN_KEY) === kind;
    },
    remember(kind) {
      session.setItem(ERROR_SEEN_KEY, kind);
    },
    /** Clears the sighting, so the next failure is a first one. Never throws. */
    forget() {
      session.removeItem(ERROR_SEEN_KEY);
    },
  };
}

/** The page's sightings, over this tab's session storage. */
export const sessionErrorSightings = createSessionErrorSightings({ session: pageSessionStorage });
