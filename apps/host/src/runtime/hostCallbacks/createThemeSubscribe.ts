// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ThemeHost } from '@parity/truapi-host';
import type { HostThemeSubscribeItem } from '@parity/truapi';
import type { ReadableStore } from '@dotli/shared';
import { themeState, type ThemeState } from '../state/themeState.js';
import { createResultStream } from './createResultStream.js';

type Params = {
  /** The theme the product follows. The page's theme state by default. */
  theme?: ReadableStore<ThemeState>;
};

/** Streams the theme variant now and on each change of it. Never throws. */
export function createThemeSubscribe({ theme = themeState.store }: Params = {}): Required<ThemeHost>['subscribeTheme'] {
  function subscribeTheme(): ReturnType<Required<ThemeHost>['subscribeTheme']> {
    let sent = getThemeItem(theme.get());
    return createResultStream<HostThemeSubscribeItem>([sent], push =>
      theme.subscribe(() => {
        const next = getThemeItem(theme.get());
        // The product sees only the variant, so a preference that resolves to the same one is nothing new.
        if (next.variant !== sent.variant) {
          sent = next;
          push(next);
        }
      }),
    );
  }

  return subscribeTheme;
}

function getThemeItem({ resolved }: ThemeState): HostThemeSubscribeItem {
  return { name: { tag: 'Default' }, variant: getThemeVariant(resolved) };
}

function getThemeVariant(resolved: ThemeState['resolved']): HostThemeSubscribeItem['variant'] {
  switch (resolved) {
    case 'light':
      return 'Light';
    case 'dark':
      return 'Dark';
  }
}
