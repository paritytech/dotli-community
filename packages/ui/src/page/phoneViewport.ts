// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { atom, onMount, type ReadableAtom } from 'nanostores';

/** The phone layout's breakpoint. */
export const PHONE_QUERY = '(max-width: 560px)';

export type PhoneViewportParams = {
  /** Asks the viewport about a media query. None at build time, where the answer is always "wide". */
  matchMedia?:
    ((query: string) => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>) | undefined;
};

/**
 * Builds the viewport's phone answer: read live on each call, and as a store that follows the media query only while
 * something listens.
 */
export function createPhoneViewport({ matchMedia }: PhoneViewportParams) {
  const phone = atom<boolean>(false);
  if (matchMedia !== undefined) {
    onMount(phone, () => {
      const query = matchMedia(PHONE_QUERY);
      function follow(): void {
        phone.set(query.matches);
      }
      follow();
      query.addEventListener('change', follow);
      return () => {
        query.removeEventListener('change', follow);
      };
    });
  }
  const store: ReadableAtom<boolean> = phone;

  return {
    /** Whether the viewport is phone sized, as the media query's last `change` left it. `false` at build time. */
    store,
    /**
     * Whether the viewport is phone sized now, asked of the media query on each call. A window `resize` runs before the
     * query fires `change`, so a resize handler reads the new answer here. `false` at build time. Never
     * throws.
     */
    isPhone,
  };

  function isPhone(): boolean {
    if (matchMedia === undefined) {
      return false;
    }
    return matchMedia(PHONE_QUERY).matches;
  }
}

// Islands are server-rendered at build time, where reads answer "wide". A component that differs on a
// phone must not read this while hydrating, or its first client render disagrees with that markup.
const phoneViewport = createPhoneViewport({
  matchMedia: typeof window === 'undefined' ? undefined : query => window.matchMedia(query),
});

/** Whether the page's viewport is phone sized now. Never throws. */
export function isPhoneViewport(): boolean {
  return phoneViewport.isPhone();
}

/**
 * Calls `onChange` with the new answer each time the page's viewport crosses the phone breakpoint, and returns the
 * removal. Never calls it at build time.
 */
export function watchPhoneViewport(onChange: (phone: boolean) => void): () => void {
  return phoneViewport.store.listen(phone => {
    onChange(phone);
  });
}
