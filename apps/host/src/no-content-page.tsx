// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page for a name that resolved to no content, in place of the page's content. The label goes in as text, so
// nothing a visitor typed is parsed as markup.

import { getActiveTldSuffix } from '@dotli/config';
import { showScreen } from '@dotli/ui';
import { NoContentPage } from './components/no-content/NoContentPage.js';

export function showNoContentError(label: string): void {
  showScreen(standalone => <NoContentPage label={label} tld={getActiveTldSuffix()} standalone={standalone} />);
}
