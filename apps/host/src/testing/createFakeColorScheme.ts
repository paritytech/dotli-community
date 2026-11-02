// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The OS colour scheme as a media query for a light scheme, which a spec switches. */
export type FakeColorScheme = ReturnType<typeof createFakeColorScheme>;

type Params = {
  /** The scheme the OS starts on. */
  scheme: 'light' | 'dark';
};

/** Builds the OS colour scheme on `scheme`. Never throws. */
export function createFakeColorScheme({ scheme }: Params) {
  const events = new EventTarget();
  let current = scheme;
  return {
    /** Whether the OS is on the light scheme. */
    get matches(): boolean {
      return current === 'light';
    },
    /** Switches the OS to `next` and tells every change listener. Throws only as a listener does. */
    set(next: 'light' | 'dark'): void {
      current = next;
      events.dispatchEvent(new Event('change'));
    },
    /** Adds a change listener. Never throws. */
    addEventListener: events.addEventListener.bind(events),
    /** Removes a change listener, and does nothing for one not added. Never throws. */
    removeEventListener: events.removeEventListener.bind(events),
  };
}
