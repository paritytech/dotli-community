// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** The OS colour scheme as a media query for a light scheme, which a spec switches. */
export class FakeColorScheme extends EventTarget {
  private scheme: 'light' | 'dark';

  constructor(scheme: 'light' | 'dark') {
    super();
    this.scheme = scheme;
  }

  get matches(): boolean {
    return this.scheme === 'light';
  }

  set(scheme: 'light' | 'dark'): void {
    this.scheme = scheme;
    this.dispatchEvent(new Event('change'));
  }
}
