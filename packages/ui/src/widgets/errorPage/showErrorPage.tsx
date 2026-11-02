// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The error page both apps show in place of the page's content. Text goes in as text, so nothing a visitor typed is
// parsed as markup.

import { pageScreen } from '../createPageScreen.js';
import type { ErrorPageContent } from './arrangeErrorActions.js';
import { ErrorPage } from './ErrorPage.js';

export type ShowErrorPage = typeof showErrorPage;

/** Shows the error page in place of the page's content and the screen before. A page that fails to render is reported. */
export function showErrorPage(page: ErrorPageContent): void {
  pageScreen.show(standalone => <ErrorPage page={page} standalone={standalone} />);
}
