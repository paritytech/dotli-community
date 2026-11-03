// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { listen } from '@dotli/shared';

/** The phone layout's breakpoint. */
export const PHONE_QUERY = '(max-width: 560px)';

/** Asks the viewport about a media query. `null` at build time, where the answer is always "wide". */
type MatchMedia = ((query: string) => EventTarget & Pick<MediaQueryList, 'matches'>) | null;

type Params = {
  matchMedia?: MatchMedia;
};

/**
 * Whether the viewport is phone sized now, asked of the media query on each call. A window `resize` runs before the
 * query fires `change`, so a resize handler reads the new answer here. `false` at build time. Never throws.
 */
export function isPhoneViewport({ matchMedia = getPageMatchMedia() }: Params = {}): boolean {
  return matchMedia?.(PHONE_QUERY).matches ?? false;
}

/**
 * Calls `onChange` with the new answer each time the viewport crosses the phone breakpoint, and returns the removal.
 * Each watcher listens to the media query itself. Never calls it at build time. Never throws.
 */
export function watchPhoneViewport(
  onChange: (phone: boolean) => void,
  { matchMedia = getPageMatchMedia() }: Params = {},
): () => void {
  if (matchMedia === null) {
    return () => undefined;
  }
  const query = matchMedia(PHONE_QUERY);
  return listen({
    target: query,
    type: 'change',
    handler: () => {
      onChange(query.matches);
    },
  });
}

// Islands are server-rendered at build time, where reads answer "wide". A component that differs on a
// phone must not read this while hydrating, or its first client render disagrees with that markup.
function getPageMatchMedia(): MatchMedia {
  return typeof window === 'undefined' ? null : query => window.matchMedia(query);
}
