// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { BASE_DOMAIN } from '@dotli/config';

/** Where the page is served from, which decides the form of a name's address. */
export type PageLocation = Pick<Location, 'hostname' | 'protocol' | 'port'>;

export function dotUrl(label: string, page: PageLocation = window.location): string {
  const host = page.hostname;
  if (host.endsWith('.localhost') || host === 'localhost') {
    return `${page.protocol}//${label}.localhost:${page.port}`;
  }
  return `https://${label}.${BASE_DOMAIN}`;
}

/** The name a visitor typed, trimmed and lowercased. The TLD shows beside the input, so a visitor may type it too. */
export function typedName(value: string, suffix: string): string {
  const typed = value.trim().toLowerCase();
  return typed.endsWith(suffix) ? typed.slice(0, -suffix.length) : typed;
}
