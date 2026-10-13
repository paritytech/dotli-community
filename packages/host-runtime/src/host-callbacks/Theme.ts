// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ThemeHost } from '@parity/truapi-host';
import type { HostThemeSubscribeItem } from '@parity/truapi';
import type { ReadableStore } from '@dotli/shared';
import { themeStore, type ThemeState } from '../state/theme.js';
import { createResultStream } from './result-stream.js';

function themeItem({ resolved }: ThemeState): HostThemeSubscribeItem {
  return { name: { tag: 'Default' }, variant: resolved === 'light' ? 'Light' : 'Dark' };
}

export function createThemeSubscribe(
  theme: ReadableStore<ThemeState> = themeStore,
): Required<ThemeHost>['subscribeTheme'] {
  return () => {
    let sent = themeItem(theme.get());
    return createResultStream<HostThemeSubscribeItem>([sent], push =>
      theme.subscribe(() => {
        const next = themeItem(theme.get());
        // The product sees only the variant, so a preference that resolves to the same one is nothing new.
        if (next.variant !== sent.variant) {
          sent = next;
          push(next);
        }
      }),
    );
  };
}
