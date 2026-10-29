// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page for a name that resolved to no content, in place of the page's content. The label goes in as text, so
// nothing a visitor typed is parsed as markup.

import { getActiveTldSuffix } from '@dotli/config';
import { pageScreen } from '@dotli/ui';
import { NoContentPage } from './components/noContent/NoContentPage.js';

/** Shows the no-content page for `label` in place of the page's content. */
export function showNoContentError(label: string): void {
  pageScreen.show(standalone => <NoContentPage label={label} tld={getActiveTldSuffix()} standalone={standalone} />);
}
