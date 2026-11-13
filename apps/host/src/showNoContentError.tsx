// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page for a name that resolved to no content, in place of the page's content. The label goes in as text, so
// nothing a visitor typed is parsed as markup.

import { getActiveTldSuffix } from '@dotli/config';
import { pageScreen } from '@dotli/ui';
import { NoContentPage } from './components/noContent/NoContentPage.js';
import { getPageLandingUrl } from './getLandingUrl.js';

type Params = {
  /** Opens the landing page. */
  openUrl?: (url: string) => void;
};

/** Shows the no-content page for `label` in place of the page's content. */
export function showNoContentError(
  label: string,
  {
    // Not `window.location.assign` bare, which throws without its `this`.
    openUrl = url => {
      window.location.assign(url);
    },
  }: Params = {},
): void {
  // The landing form rejects a dot, so a subname leaves the box empty.
  const name = label.includes('.') ? undefined : label;
  pageScreen.show(standalone => (
    <NoContentPage
      label={label}
      tld={getActiveTldSuffix()}
      standalone={standalone}
      onSearchAgain={() => {
        openUrl(getPageLandingUrl(name));
      }}
    />
  ));
}
