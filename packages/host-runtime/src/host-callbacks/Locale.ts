// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { LocaleHost } from '@parity/truapi-host';
import type { HostLocaleSubscribeItem } from '@parity/truapi';
import { createResultStream } from './result-stream.js';

// dotli has no language setting, so the browser preference is the only signal a product can localize against.
export interface LocaleDeps {
  language: () => string;
  /** Where `languagechange` arrives. */
  events: () => EventTarget;
}

const pageLocale: LocaleDeps = { language: () => navigator.language, events: () => window };

export function createLocaleSubscribe({
  language,
  events,
}: LocaleDeps = pageLocale): Required<LocaleHost>['subscribeLocale'] {
  const currentLocale = (): HostLocaleSubscribeItem => ({ languageTag: language() });
  return () =>
    createResultStream<HostLocaleSubscribeItem>([currentLocale()], push => {
      const target = events();
      const onLanguageChanged = (): void => {
        push(currentLocale());
      };
      target.addEventListener('languagechange', onLanguageChanged);
      return () => {
        target.removeEventListener('languagechange', onLanguageChanged);
      };
    });
}
