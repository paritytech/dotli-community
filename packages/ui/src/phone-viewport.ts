// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The phone layout's breakpoint. Stylesheets repeat it as `@media (max-width: 560px)`. */
export const PHONE_QUERY = '(max-width: 560px)';

// One list for the session: it is read on hot paths and each matchMedia call parses and allocates.
let phoneList: MediaQueryList | null = null;

function phoneQuery(): MediaQueryList {
  phoneList ??= window.matchMedia(PHONE_QUERY);
  return phoneList;
}

// Islands are server-rendered at build time, where reads answer "wide". A component that differs on a
// phone must not read this while hydrating, or its first client render disagrees with that markup.
const serverRendering = (): boolean => typeof window === 'undefined';

export function isPhoneViewport(): boolean {
  return !serverRendering() && phoneQuery().matches;
}

export function watchPhoneViewport(onChange: (phone: boolean) => void): () => void {
  if (serverRendering()) {
    return () => undefined;
  }
  const query = phoneQuery();
  const notify = (): void => {
    onChange(query.matches);
  };
  query.addEventListener('change', notify);
  return () => {
    query.removeEventListener('change', notify);
  };
}

/** For tests, so the next read reaches a stubbed `matchMedia`. */
export function resetPhoneViewport(): void {
  phoneList = null;
}
