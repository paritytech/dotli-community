// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Pure DOM UI helpers
//
// No heavy dependencies and no Solid (the sandbox imports this), kept in the
// eager bundle. Text goes in as text nodes, so nothing a visitor typed is ever
// parsed as markup.

import { getActiveTldSuffix } from '@dotli/config';
import { RELOAD_GLYPH } from './reload-glyph.js';
import s from './ErrorPage.module.css';
import retry from './RetryScreen.module.css';
import { PETAL_PATHS } from './petal-mark.js';
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

const CLOUD_OFF_GLYPH = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m2 2 20 20M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193m2.725-2.307A4.5 4.5 0 0 0 17.5 10h-1.79A7.01 7.01 0 0 0 10 5.07"/></svg>`;

const SHIELD_ALERT_GLYPH = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1zm-8-5v4m0 4h.01"/></svg>`;

const GLOBE_GLYPH = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;

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

/** The page carries `data-error-page`, which bridge.ts looks for when it clears a stray one. */
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
  /** Things worth checking before retrying, listed under a "Try" heading. */
  tips?: readonly string[];
  /**
   * One button per entry. The first keeps `#error-retry-btn` regardless of
   * which one is `primary`.
   */
  actions?: readonly ErrorAction[];
  /** The warning interstitial's amber shield, in place of the generic glyph. */
  glyph?: 'warning';
}

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
  inner.append(glyph === 'warning' ? glyphElement(SHIELD_ALERT_GLYPH, true) : glyphElement(CLOUD_OFF_GLYPH, false));
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
    icon: RELOAD_GLYPH,
    onClick: () => {
      window.location.reload();
    },
  });
}

/**
 * Show the "no content set" error in a Chrome-style "site can't be reached"
 * layout. The domain sits on its own chip so the user can immediately scan
 * it for a typo.
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
  const host = el('span', s['domainHost']);
  host.textContent = label;
  const tld = el('span', s['domainTld']);
  tld.textContent = getActiveTldSuffix();
  domain.append(host, tld);
  // The chip stays inside the sentence, so a screen reader hears it as one.
  const line = el('p', s['detail']);
  line.dataset['testid'] = 'error-page-detail';
  line.append('Check if there is a typo in ', domain);
  inner.append(glyphElement(GLOBE_GLYPH, false), heading, line);
  mountErrorPage(inner);

  setProductError();
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The loading screen's petal mark, pulsing, built here so the sandbox never loads the island. */
function petalMark(): SVGSVGElement {
  const mark = document.createElementNS(SVG_NS, 'svg');
  mark.setAttribute('width', '56');
  mark.setAttribute('height', '56');
  mark.setAttribute('viewBox', '0 0 256 256');
  mark.setAttribute('fill', 'none');
  mark.setAttribute('aria-hidden', 'true');
  mark.setAttribute('class', retry['mark'] ?? '');
  for (const d of PETAL_PATHS) {
    const petal = document.createElementNS(SVG_NS, 'path');
    petal.setAttribute('d', d);
    petal.setAttribute('class', retry['petal'] ?? '');
    mark.append(petal);
  }
  return mark;
}

export function showRetryScreen(): void {
  const app = appElement();
  const screen = el('div', retry['screen'], app === document.body ? retry['standalone'] : undefined);
  screen.dataset['testid'] = 'retry-screen';
  const column = el('div', retry['column']);
  const status = el('p', retry['step']);
  status.id = 'status';
  status.textContent = 'Retrying…';
  const line = el('p', retry['line']);
  line.textContent = "The app's connection dropped, so it is starting again";
  column.append(petalMark(), status, line);
  screen.append(column);
  app.replaceChildren(screen);
}
