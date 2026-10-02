// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Pure DOM UI helpers
//
// Error states, and the sandbox's retry screen. The loading screen lives in
// loading-controller.ts and the landing page in components/landing/ (the
// LandingPage island). No heavy dependencies and no Solid (the sandbox
// imports this), kept in the eager bundle. The screens are built with
// `createElement` and styled by ErrorPage.module.css and
// RetryScreen.module.css. Text goes in as text nodes, so nothing a visitor
// typed is ever parsed as markup.

import { getActiveTldSuffix } from '@dotli/config';
import spinner from './components/primitives/Spinner.module.css';
import s from './ErrorPage.module.css';
import retry from './RetryScreen.module.css';
import { setProductError } from './state/product.js';
import { setLandingPage } from './state/topbar.js';
import { disposeAppRoots } from './mount/app-roots.js';

/** Where the error pages go, looked up when one shows. */
function appElement(): HTMLElement {
  return document.getElementById('app') ?? document.body;
}

/**
 * Clear the page for an error page: dispose the loading screen and any page
 * root, whose timers stop with them, and take the landing page down (the
 * LandingPage island hides, and the topbar and `#app` come back).
 */
function clearPage(): void {
  disposeAppRoots();
  setLandingPage(false);
}

/** A new `tag` element carrying the module classes in `classes`. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  ...classes: (string | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.classList.add(...classes.filter((c): c is string => c !== undefined));
  return node;
}

export interface ErrorAction {
  label: string;
  onClick: (event: MouseEvent) => void;
  /**
   * The recommended way out. Rendered filled and pushed to the right of the
   * row, whatever its position in the array. Defaults to the first action, so
   * a lone button is always the primary one.
   */
  primary?: boolean;
  /** Inline SVG markup for a leading icon. Constant only, never user input. */
  icon?: string;
}

/**
 * The topbar's own Settings gear, so a button that opens that panel carries the
 * same mark the visitor is being sent to look for. The path data matches the
 * `#mode-button` icon (components/shell/SettingsPopover.tsx). Only the 12px
 * box is widened to 15px, so it sits with the button text.
 */
export const SETTINGS_GLYPH = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

const WARNING_GLYPH = `<svg width="44" height="44" viewBox="0 0 24 24" fill="currentColor"><path d="M10.3 3.2 1.8 17.5A2 2 0 0 0 3.5 20.5h17a2 2 0 0 0 1.7-3L13.7 3.2a2 2 0 0 0-3.4 0z"></path><path fill="#fff" d="M11 8.5h2v5h-2zM11 15.5h2v2h-2z"></path></svg>`;

const GLOBE_GLYPH = `<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5"></circle><path d="M3.5 12h17"></path><path d="M12 2.5c2.5 3 3.75 6.2 3.75 9.5s-1.25 6.5-3.75 9.5"></path><path d="M12 2.5c-2.5 3-3.75 6.2-3.75 9.5s1.25 6.5 3.75 9.5"></path></svg>`;

/**
 * A sentence, optionally with parts picked out in bold. Spelled as segments
 * rather than markup so every piece goes in as text.
 */
export type ErrorText = string | readonly (string | { strong: string })[];

function errorText(text: ErrorText): (string | Node)[] {
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

/** The leading glyph: constant SVG markup in an `aria-hidden` box. */
function glyphElement(svg: string, warning: boolean): HTMLElement {
  const glyph = el('div', s['glyph']);
  glyph.dataset['testid'] = 'error-page-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  if (warning) {
    glyph.setAttribute('data-warning', '');
  }
  glyph.innerHTML = svg;
  return glyph;
}

/**
 * Replace whatever the page shows with an error page holding `inner`. The
 * page carries `data-error-page`, which bridge.ts looks for when it clears a
 * stray one.
 */
function mountErrorPage(inner: HTMLElement): void {
  const app = appElement();
  const page = el('div', s['page'], app === document.body ? s['standalone'] : undefined);
  page.dataset['testid'] = 'error-page';
  page.setAttribute('data-error-page', '');
  page.append(inner);
  app.replaceChildren(page);
}

export interface ErrorPage {
  title: string;
  /** Paragraph below the title. Omit for a title-only screen. */
  detail?: ErrorText | undefined;
  /** Things worth checking before retrying, listed under a "Try:" heading. */
  tips?: readonly string[];
  /**
   * One button per entry. The first keeps `#error-retry-btn` regardless of
   * which one is `primary`.
   */
  actions?: readonly ErrorAction[];
  /** Leading glyph. Only the warning interstitial carries one today. */
  glyph?: 'warning';
}

/** One action button, `#id`, filled when it is the `primary` one. */
function actionButton(action: ErrorAction, id: string, primary: boolean): HTMLButtonElement {
  const button = el('button', s['retry']);
  button.id = id;
  if (primary) {
    button.setAttribute('data-primary', '');
  }
  if (action.icon !== undefined) {
    const icon = el('span', s['retryIcon']);
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = action.icon;
    button.append(icon);
  }
  const label = el('span');
  label.dataset['testid'] = 'error-page-retry-label';
  label.textContent = action.label;
  button.append(label);
  button.addEventListener('click', action.onClick);
  return button;
}

/** Render a full-page error state, replacing whatever `#app` holds. */
export function showErrorPage(page: ErrorPage): void {
  // The page below replaces the loading screen and any page.
  clearPage();
  const { title, detail, glyph } = page;
  const tips = page.tips ?? [];
  const actions = page.actions ?? [];
  const idFor = (i: number): string => (i === 0 ? 'error-retry-btn' : `error-retry-btn-${String(i)}`);
  const declaredPrimary = actions.findIndex(a => a.primary === true);
  const primaryIndex = declaredPrimary === -1 ? 0 : declaredPrimary;
  // Rendered with the primary last so reading order, DOM order and tab order
  // all agree. The id still comes from the array position, so `#error-retry-btn`
  // is the first action whichever one is recommended.
  const rendered = actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => Number(x.i === primaryIndex) - Number(y.i === primaryIndex));

  const inner = el('div', s['inner']);
  if (glyph === 'warning') {
    inner.append(glyphElement(WARNING_GLYPH, true));
  }
  const heading = el('h1', s['title']);
  heading.dataset['testid'] = 'error-page-title';
  heading.tabIndex = -1;
  heading.textContent = title;
  inner.append(heading);
  if (detail !== undefined) {
    const line = el('p', s['detail']);
    line.dataset['testid'] = 'error-page-detail';
    line.append(...errorText(detail));
    inner.append(line);
  }
  if (tips.length > 0) {
    const box = el('div', s['tips']);
    box.dataset['testid'] = 'error-page-tips';
    const label = el('p', s['tipsLabel']);
    label.textContent = 'Try:';
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
    row.append(...rendered.map(({ a, i }) => actionButton(a, idFor(i), i === primaryIndex)));
    inner.append(row);
  }
  mountErrorPage(inner);

  // The button that triggered this render is gone, so focus would otherwise
  // fall to `body` and a screen reader would announce nothing. Moving it to the
  // title both names the new screen and puts the actions next in tab order.
  // Matters most on the failover interstitial, which replaces one error screen
  // with another in place.
  heading.focus();

  setProductError();
}

/**
 * Positional shorthand for {@link showErrorPage}, kept because most callers
 * only ever need a title, a line of detail and a retry.
 */
export function showError(
  title: string,
  detail?: string,
  action?: ErrorAction | ErrorAction[] | (() => void),
  tips: readonly string[] = [],
): void {
  if (typeof action === 'function') {
    action = { label: 'Retry', onClick: action };
  }
  showErrorPage({
    title,
    detail,
    tips,
    actions: action === undefined ? [] : Array.isArray(action) ? action : [action],
  });
}

/**
 * The "reload" error page, for a page of the host's own (the landing page)
 * that cannot show.
 */
export function showBrokenPage(): void {
  showError('Something went wrong on our side', "This page didn't load properly. Reloading usually fixes it.", {
    label: 'Reload',
    onClick: () => {
      window.location.reload();
    },
  });
}

/**
 * Show the "no content set" error in a Chrome-style "site can't be reached"
 * layout. The domain is highlighted so the user can immediately scan for a
 * typo, and a secondary hint explains the network reason without burying it.
 */
export function showNoContentError(label: string): void {
  // Replaces the loading screen mid-load.
  clearPage();
  const inner = el('div', s['inner'], s['unreached']);
  const heading = el('h1', s['title']);
  heading.dataset['testid'] = 'error-page-title';
  heading.textContent = "This app can't be reached";
  const domain = el('span', s['domain']);
  domain.dataset['testid'] = 'error-page-domain';
  const tld = el('span', s['domainTld']);
  tld.textContent = getActiveTldSuffix();
  domain.append(label, tld);
  const line = el('p', s['detail']);
  line.dataset['testid'] = 'error-page-detail';
  line.append('Check if there is a typo in ', domain, '.');
  inner.append(glyphElement(GLOBE_GLYPH, false), heading, line);
  mountErrorPage(inner);

  setProductError();
}

/**
 * The sandbox's retry screen, shown in place of its error page while a failed
 * load runs again: the name, a spinner and a status line.
 */
export function showRetryScreen(): void {
  const screen = el('div');
  screen.dataset['testid'] = 'retry-screen';
  const title = el('h1', retry['title']);
  title.textContent = 'dot.li';
  const status = el('p', retry['status']);
  status.id = 'status';
  status.textContent = 'Retrying...';
  screen.append(title, el('div', spinner['spinner']), status);
  appElement().replaceChildren(screen);
}
