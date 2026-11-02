// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ErrorAction } from './arrangeErrorActions.js';
import { showErrorPage } from './showErrorPage.js';

type Params = {
  /** The message under the title, as text. */
  detail?: string | undefined;
  /** The page's buttons. A bare callback becomes a Retry button. */
  action?: ErrorAction | ErrorAction[] | (() => void) | undefined;
  /** Listed under a "Try" heading. None by default. */
  tips?: readonly string[] | undefined;
};

/**
 * Shows the error page titled `title` in place of the page's content and the screen before, with the detail, buttons
 * and tips given. Never throws: a page that fails to render is reported and renders nothing.
 */
export function showError(title: string, { detail, action, tips = [] }: Params = {}): void {
  showErrorPage({ title, detail, tips, actions: toActions(action) });
}

function toActions(action: ErrorAction | ErrorAction[] | (() => void) | undefined): readonly ErrorAction[] {
  if (action === undefined) {
    return [];
  }
  if (typeof action === 'function') {
    return [{ label: 'Retry', onClick: action }];
  }
  if (Array.isArray(action)) {
    return action;
  }
  return [action];
}
