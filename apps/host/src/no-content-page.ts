// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page for a name that resolved to no content. Its view loads in a lazy chunk, and when that cannot load the shared
// error page says the same in text alone. The label goes in as text, so nothing a visitor typed is parsed as markup.

import { getActiveTldSuffix } from '@dotli/config';
import type { Reporter } from '@dotli/ui-core';
import { renderErrorPageText, showPageScreen } from '@dotli/ui-widgets';
import { loadNoContentPage, type NoContentPageModule } from './lazy.js';
import { uiReporter } from './ui-reporter.js';

export const NO_CONTENT_TITLE = "This app can't be reached";
export const NO_CONTENT_LINE = 'Check if there is a typo in';

export interface NoContentDeps {
  load: () => Promise<NoContentPageModule>;
  /** Takes a view chunk that failed to load and a view that broke while rendering. */
  report: Reporter;
}

const pageDeps: NoContentDeps = { load: loadNoContentPage, report: uiReporter };

/** Settles once the page shows. The page's content roots are disposed before it returns. */
export function showNoContentError(label: string, deps: NoContentDeps = pageDeps): Promise<void> {
  return showPageScreen({
    root: 'no-content-page',
    load: deps.load,
    mount: ({ mountNoContentPage }, slot) => {
      mountNoContentPage(slot, label);
    },
    fallback: slot =>
      renderErrorPageText(slot, {
        title: NO_CONTENT_TITLE,
        detail: [`${NO_CONTENT_LINE} `, { strong: `${label}${getActiveTldSuffix()}` }],
      }),
    report: deps.report,
  });
}
