// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { LocaleHost } from '@parity/truapi-host';
import type { HostLocaleSubscribeItem } from '@parity/truapi';
import { createResultStream } from './createResultStream.js';

// dotli has no language setting, so the browser preference is the only signal a product can localize against.
type Params = {
  /** The browser's preferred language tag, read on each change. The page's navigator language by default. */
  language?: () => string;
  /** Where `languagechange` arrives. The page's window by default. */
  events?: () => EventTarget;
};

/** Streams the browser's language now and on each `languagechange`. Never throws. */
export function createLocaleSubscribe({
  language = () => navigator.language,
  events = () => window,
}: Params = {}): Required<LocaleHost>['subscribeLocale'] {
  function getCurrentLocale(): HostLocaleSubscribeItem {
    return { languageTag: language() };
  }

  return () =>
    createResultStream<HostLocaleSubscribeItem>([getCurrentLocale()], push => {
      function handleLanguageChange(): void {
        push(getCurrentLocale());
      }

      const target = events();
      target.addEventListener('languagechange', handleLanguageChange);
      return () => {
        target.removeEventListener('languagechange', handleLanguageChange);
      };
    });
}
