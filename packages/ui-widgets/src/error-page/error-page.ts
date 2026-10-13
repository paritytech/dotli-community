// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The error page both apps show. It takes the page's content down at once, then shows the page as a Solid view from a
// lazy chunk, or as text alone when that chunk cannot load. Both apps' boot imports this, so it imports no Solid. Text
// goes in as text in both versions, so nothing a visitor typed is parsed as markup.

import type { IconComponent, Reporter } from '@dotli/ui-core';
import { loadErrorPageMount } from '../lazy.js';
import { showPageScreen, type PageSlot } from '../page-screen.js';
import s from './ErrorPage.module.css';

export interface ErrorAction {
  label: string;
  onClick: (event: MouseEvent) => void;
  /** Rendered last whatever its array position. Defaults to the first action. */
  primary?: boolean;
  /** Leads the label. The text version shows the label alone. */
  icon?: IconComponent;
}

/** Segments rather than markup, so every piece goes in as text. */
export type ErrorText = string | readonly (string | { strong: string })[];

export interface ErrorPageContent {
  title: string;
  detail?: ErrorText | undefined;
  /** Listed under a "Try" heading. */
  tips?: readonly string[];
  /** The first keeps `#error-retry-btn` whichever one is `primary`. */
  actions?: readonly ErrorAction[];
  glyph?: 'warning';
}

/** An action as the page renders it. */
export interface ArrangedAction {
  action: ErrorAction;
  /** By array position, so the first action keeps `error-retry-btn` wherever it renders. */
  id: string;
  primary: boolean;
}

/**
 * The actions in render order: the primary, the one marked or else the first, goes last, so reading, DOM and tab order
 * agree.
 */
export function arrangeErrorActions(actions: readonly ErrorAction[]): ArrangedAction[] {
  const idFor = (i: number): string => (i === 0 ? 'error-retry-btn' : `error-retry-btn-${String(i)}`);
  const declaredPrimary = actions.findIndex(a => a.primary === true);
  const primaryIndex = declaredPrimary === -1 ? 0 : declaredPrimary;
  return actions
    .map((action, i) => ({ action, id: idFor(i), primary: i === primaryIndex }))
    .sort((x, y) => Number(x.primary) - Number(y.primary));
}

/** The error page's app root, which a later full-page screen takes down. */
const ERROR_PAGE_ROOT = 'error-page';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  ...classes: (string | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.classList.add(...classes.filter((c): c is string => c !== undefined));
  return node;
}

function textParts(text: ErrorText): (string | Node)[] {
  if (typeof text === 'string') {
    return [text];
  }
  return text.map(part => {
    if (typeof part === 'string') {
      return part;
    }
    const strong = document.createElement('strong');
    strong.textContent = part.strong;
    return strong;
  });
}

function actionButton({ action, id, primary }: ArrangedAction): HTMLButtonElement {
  const button = el('button', s['retry']);
  button.id = id;
  if (primary) {
    button.setAttribute('data-primary', '');
  }
  const label = el('span');
  label.dataset['testid'] = 'error-page-retry-label';
  label.textContent = action.label;
  button.append(label);
  button.addEventListener('click', action.onClick);
  return button;
}

/**
 * The error page in text alone, for when its view's chunk cannot load. It is the one screen still built with DOM calls,
 * and it draws no icon. Returns the page it put in the slot.
 */
export function renderErrorPageText({ app, standalone }: PageSlot, page: ErrorPageContent): HTMLElement {
  const tips = page.tips ?? [];
  const actions = page.actions ?? [];
  const inner = el('div', s['inner']);
  const heading = el('h1', s['title']);
  heading.dataset['testid'] = 'error-page-title';
  heading.textContent = page.title;
  heading.tabIndex = -1;
  inner.append(heading);
  if (page.detail !== undefined) {
    const line = el('p', s['detail']);
    line.dataset['testid'] = 'error-page-detail';
    line.append(...textParts(page.detail));
    inner.append(line);
  }
  if (tips.length > 0) {
    const box = el('div', s['tips']);
    box.dataset['testid'] = 'error-page-tips';
    const label = el('p', s['tipsLabel']);
    label.textContent = 'Try';
    const list = el('ul', s['tipsList']);
    list.dataset['testid'] = 'error-page-tips-list';
    for (const tip of tips) {
      const item = document.createElement('li');
      item.textContent = tip;
      list.append(item);
    }
    box.append(label, list);
    inner.append(box);
  }
  if (actions.length > 0) {
    const row = el('div', s['actions']);
    row.dataset['testid'] = 'error-page-actions';
    row.append(...arrangeErrorActions(actions).map(arranged => actionButton(arranged)));
    inner.append(row);
  }
  // `data-error-page` lets the page find and clear a stray error page.
  const shown = el('div', s['page'], standalone ? s['standalone'] : undefined);
  shown.dataset['testid'] = 'error-page';
  shown.setAttribute('data-error-page', '');
  shown.append(inner);
  app.replaceChildren(shown);
  // As in the view: the triggering button is gone, and the title names the new screen.
  heading.focus();
  return shown;
}

export type ErrorPageMountModule = Awaited<ReturnType<typeof loadErrorPageMount>>;

/** The page's error page, reporting through the page's reporter. */
export interface ErrorPageScreen {
  /** Settles once the page shows. The page's content roots are disposed before it returns. */
  showErrorPage: (page: ErrorPageContent) => Promise<void>;
  /** Positional shorthand for `showErrorPage`. A bare callback becomes a Retry button. */
  showError: (
    title: string,
    detail?: string,
    action?: ErrorAction | ErrorAction[] | (() => void),
    tips?: readonly string[],
  ) => Promise<void>;
}

/** `report` takes a view chunk that failed to load and a view that broke while rendering. */
export function createErrorPage(
  report: Reporter,
  load: () => Promise<ErrorPageMountModule> = loadErrorPageMount,
): ErrorPageScreen {
  const showErrorPage = (page: ErrorPageContent): Promise<void> =>
    showPageScreen({
      root: ERROR_PAGE_ROOT,
      load,
      mount: ({ mountErrorPage }, slot) => {
        mountErrorPage(slot, page);
      },
      fallback: slot => renderErrorPageText(slot, page),
      report,
    });
  return {
    showErrorPage,
    showError: (title, detail, action, tips = []) => {
      const actions = typeof action === 'function' ? [{ label: 'Retry', onClick: action }] : action;
      return showErrorPage({
        title,
        detail,
        tips,
        actions: actions === undefined ? [] : Array.isArray(actions) ? actions : [actions],
      });
    },
  };
}
