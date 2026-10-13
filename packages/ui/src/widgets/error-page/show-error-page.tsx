// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The error page both apps show in place of the page's content. Text goes in as text, so nothing a visitor typed is
// parsed as markup.

import { showScreen } from '../page-screen.js';
import type { ErrorAction, ErrorPageContent } from './error-page.js';
import { ErrorPage } from './ErrorPage.js';

export type ShowErrorPage = (page: ErrorPageContent) => void;

export const showErrorPage: ShowErrorPage = page => {
  showScreen(standalone => <ErrorPage page={page} standalone={standalone} />);
};

/** Positional shorthand for `showErrorPage`. A bare callback becomes a Retry button. */
export function showError(
  title: string,
  detail?: string,
  action?: ErrorAction | ErrorAction[] | (() => void),
  tips: readonly string[] = [],
): void {
  const actions = typeof action === 'function' ? [{ label: 'Retry', onClick: action }] : action;
  showErrorPage({
    title,
    detail,
    tips,
    actions: actions === undefined ? [] : Array.isArray(actions) ? actions : [actions],
  });
}
