// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The phone layout's breakpoint. Stylesheets repeat it as `@media (max-width: 560px)`. */
export const PHONE_QUERY = '(max-width: 560px)';

// Islands are server-rendered at build time, where reads answer "wide". A component that differs on a
// phone must not read this while hydrating, or its first client render disagrees with that markup.
const serverRendering = (): boolean => typeof window === 'undefined';

export function isPhoneViewport(): boolean {
  return !serverRendering() && window.matchMedia(PHONE_QUERY).matches;
}

export function watchPhoneViewport(onChange: (phone: boolean) => void): () => void {
  if (serverRendering()) {
    return () => undefined;
  }
  const query = window.matchMedia(PHONE_QUERY);
  const notify = (): void => {
    onChange(query.matches);
  };
  query.addEventListener('change', notify);
  return () => {
    query.removeEventListener('change', notify);
  };
}
