// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The landing page (components/landing/Landing.tsx): the name form, the typing placeholder, the recently visited
// pills, and the auth and theme buttons it renders in its corner.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flush } from 'solid-js';
import { getActiveTldSuffix } from '@dotli/config';
import { mountLandingPage } from '../../helpers/landing.js';
import { byId, byTestId, query } from '../../support.js';
import { nth } from '../../helpers/nth.js';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../../metrics/src/sentry.js', () => sentry);

const recents = vi.hoisted(() => ({
  labels: [] as string[],
  forget: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../src/recent-labels.js', () => ({
  loadRecentLabels: () => Promise.resolve([...recents.labels]),
  forgetRecentLabel: recents.forget,
}));

const SUFFIX = getActiveTldSuffix();

let reducedMotion = false;
let page: ReturnType<typeof mountLandingPage> | null = null;

function mount(): ReturnType<typeof mountLandingPage> {
  page = mountLandingPage();
  return page;
}

/** Let the recents load and render. */
async function settle(): Promise<void> {
  flush();
  await Promise.resolve();
  await Promise.resolve();
  flush();
}

function type(value: string): void {
  const input = byId('dotli-nav-input', HTMLInputElement);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function submit(): Event {
  const event = new Event('submit', { bubbles: true, cancelable: true });
  byId('dotli-nav-form').dispatchEvent(event);
  return event;
}

function items(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="landing-recent-item"]')];
}

function touch(target: Element, kind: string): void {
  target.dispatchEvent(new Event(kind, { bubbles: true }));
}

function click(target: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  reducedMotion = false;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' && reducedMotion,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal('location', {
    hostname: 'localhost',
    protocol: 'http:',
    port: '5173',
    href: 'http://localhost:5173/',
  });
  recents.labels = [];
  recents.forget.mockClear();
  sentry.captureException.mockClear();
  document.body.innerHTML = '';
});

afterEach(() => {
  page?.dispose();
  page = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('landing page', () => {
  it('As a visitor, the landing page shows its heading, the name form and no recents row yet', async () => {
    // When
    const { view } = mount();
    await settle();

    // Then
    expect(view.children).toHaveLength(1);
    expect(nth(view.children, 0).getAttribute('data-testid')).toBe('landing');
    expect(query(view, 'h1').textContent).toBe('Polkadot Web');
    expect(query(view, 'p').textContent).toBe('The decentralized web, in your browser.');
    expect(byId('dotli-nav-input', HTMLInputElement).getAttribute('aria-label')).toBe(`Search a ${SUFFIX} name`);
    const input = byId('dotli-nav-input', HTMLInputElement);
    expect(input.getAttribute('aria-describedby')).toBe('dotli-nav-error');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(query(view, 'button[type="submit"]').getAttribute('aria-label')).toBe('Go');
    expect(byId('dotli-nav-error').hidden).toBe(true);
    expect(byId('dotli-recent').hidden).toBe(true);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('As a visitor, nothing is focused when the page loads, so a screen reader starts at the top and no keyboard pops up', async () => {
    // When
    mount();
    await settle();

    // Then
    expect(document.activeElement).toBe(document.body);
  });

  it('As a visitor who types an invalid name, I see why inline and stay on the page, and the error clears when I type again', async () => {
    // Given
    mount();
    await settle();

    // When
    type('Bad Name');
    const event = submit();
    await settle();

    // Then
    const input = byId('dotli-nav-input', HTMLInputElement);
    const error = byId('dotli-nav-error');
    expect(event.defaultPrevented).toBe(true);
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('Names can only contain a-z, 0-9 and hyphens');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(byId('dotli-nav-bar').hasAttribute('data-invalid')).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(window.location.href).toBe('http://localhost:5173/');

    // When
    type('bad');
    await settle();

    // Then
    expect(error.hidden).toBe(true);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(byId('dotli-nav-bar').hasAttribute('data-invalid')).toBe(false);
  });

  it('As a visitor who submits nothing, I am asked for a name', async () => {
    // Given
    mount();
    await settle();

    // When
    submit();
    await settle();

    // Then
    expect(byId('dotli-nav-error').textContent).toBe('Enter a name to browse');
  });

  it('As a visitor who types a valid name, with or without the TLD, I am taken to its site', async () => {
    // Given
    mount();
    await settle();

    // When
    type(`  Mark3t${SUFFIX} `);
    submit();

    // Then
    expect(window.location.href).toBe('http://mark3t.localhost:5173');
    expect(byId('dotli-nav-error').hidden).toBe(true);
  });

  it('As a visitor on the live site, a valid name takes me to its subdomain of the base domain', async () => {
    // Given
    vi.stubGlobal('location', { hostname: 'dot.li', href: 'https://dot.li/' });
    mount();
    await settle();

    // When
    type('playground');
    submit();

    // Then
    expect(window.location.href).toMatch(/^https:\/\/playground\.[^/]+$/);
  });

  it("As a visitor, the input's first placeholder is the first example name, without the suffix", async () => {
    // Given: what the input showed each time the typing placeholder wrote it.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'placeholder');
    if (descriptor?.set === undefined) {
      throw new Error('expected a placeholder setter');
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the native setter is called with the input as its receiver below.
    const setter = descriptor.set;
    const shown: (string | null)[] = [];
    const spy = vi.spyOn(HTMLInputElement.prototype, 'placeholder', 'set').mockImplementation(function (
      this: HTMLInputElement,
      value: string,
    ) {
      shown.push(this.getAttribute('placeholder'));
      setter.call(this, value);
    });

    // When
    mount();
    await settle();
    spy.mockRestore();

    // Then: the suffix never showed in the input; it is the label beside it.
    expect(shown.length).toBeGreaterThan(0);
    expect(shown[0]).toBe('browse');
    expect(byId('dotli-nav-input', HTMLInputElement).placeholder).toBe('browse');
  });

  it('As a visitor, the placeholder types example names in turn, pauses while I type, and stops when the page goes', async () => {
    // Given
    mount();
    await settle();
    const input = byId('dotli-nav-input', HTMLInputElement);
    expect(input.placeholder).toBe('browse');

    // When: the hold ends, then one character is erased.
    vi.advanceTimersByTime(1400);
    vi.advanceTimersByTime(45);

    // Then
    expect(input.placeholder).toBe('brows');

    // When: the rest is erased and the next name typed.
    vi.advanceTimersByTime(45 * 5 + 95 * 6);

    // Then
    expect(input.placeholder).toBe('mark3t');

    // When: the visitor types, the cycle pauses.
    type('x');
    vi.advanceTimersByTime(10_000);

    // Then
    expect(input.placeholder).toBe('mark3t');
    expect(vi.getTimerCount()).toBe(0);

    // When: clearing the input resumes it.
    type('');
    vi.advanceTimersByTime(95);

    // Then
    expect(vi.getTimerCount()).toBe(1);

    // When
    page?.dispose();
    page = null;

    // Then
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As a visitor who prefers reduced motion, the placeholder shows one name and stays still', async () => {
    // Given
    reducedMotion = true;
    // The account popover's idle preload is not one of the page's timers.
    vi.stubGlobal('requestIdleCallback', () => 1);
    vi.stubGlobal('cancelIdleCallback', () => undefined);

    // When
    mount();
    await settle();

    // Then
    expect(byId('dotli-nav-input', HTMLInputElement).placeholder).toBe('browse');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('As a returning visitor, my recently visited names show as pills linking to their sites', async () => {
    // Given
    recents.labels = ['alpha', 'beta'];

    // When
    mount();
    await settle();

    // Then
    const recent = byId('dotli-recent');
    expect(recent.hidden).toBe(false);
    expect(recent.children).toHaveLength(1);
    expect(recent.children[0]?.getAttribute('data-testid')).toBe('landing-recent-list');
    expect(items().map(item => item.dataset['label'])).toEqual(['alpha', 'beta']);
    const pill = nth(items(), 0).querySelector<HTMLAnchorElement>('a[data-testid="landing-recent-pill"]');
    expect(pill?.getAttribute('href')).toBe('http://alpha.localhost:5173');
    expect(pill?.textContent).toBe(`alpha${SUFFIX}`);
    expect(pill?.querySelector('[data-testid="landing-recent-label"] > [data-testid="landing-tld"]')?.textContent).toBe(
      SUFFIX,
    );
    const remove = nth(items(), 0).querySelector('button[data-testid="landing-recent-remove"]');
    expect(remove?.getAttribute('type')).toBe('button');
    expect(remove?.getAttribute('aria-label')).toBe(`Remove alpha${SUFFIX} from recently visited`);
    expect(remove?.getAttribute('title')).toBe('Remove');
    expect(remove?.querySelectorAll('svg line')).toHaveLength(2);
  });

  it('As a visitor with no recently visited names, no recents row shows', async () => {
    // When
    mount();
    await settle();

    // Then
    expect(byId('dotli-recent').hidden).toBe(true);
    expect(byId('dotli-recent').children).toHaveLength(0);
  });

  it('As a visitor, a recent name that holds markup shows as text', async () => {
    // Given
    const hostile = `<img src=x onerror="alert(1)">`;
    recents.labels = [hostile];

    // When
    mount();
    await settle();

    // Then
    expect(document.querySelector('img')).toBeNull();
    expect(items()[0]?.dataset['label']).toBe(hostile);
    expect(byTestId('landing-recent-label', nth(items(), 0)).firstChild?.textContent).toBe(hostile);
  });

  it('As a returning visitor, the remove button forgets a name, and the row goes once none is left', async () => {
    // Given
    recents.labels = ['alpha', 'beta'];
    mount();
    await settle();

    // When
    const event = click(byTestId('landing-recent-remove', nth(items(), 0), Element));
    await settle();

    // Then
    expect(event.defaultPrevented).toBe(true);
    expect(recents.forget).toHaveBeenCalledWith('alpha');
    expect(items().map(item => item.dataset['label'])).toEqual(['beta']);
    expect(byId('dotli-recent').hidden).toBe(false);

    // When
    click(query(nth(items(), 0), '[data-testid="landing-recent-remove"] svg', Element));
    await settle();

    // Then
    expect(recents.forget).toHaveBeenLastCalledWith('beta');
    expect(items()).toHaveLength(0);
    expect(byId('dotli-recent').hidden).toBe(true);
    expect(byId('dotli-recent').children).toHaveLength(0);
  });

  it('As a touch visitor, a long press on a pill reveals its remove button instead of navigating, and a tap elsewhere hides it', async () => {
    // Given
    recents.labels = ['alpha', 'beta'];
    mount();
    await settle();
    const alpha = nth(items(), 0);
    const beta = nth(items(), 1);
    const alphaPill = byTestId('landing-recent-pill', alpha, Element);

    // When: a press that moves is a scroll, not a long press.
    touch(alphaPill, 'touchstart');
    vi.advanceTimersByTime(200);
    touch(alphaPill, 'touchmove');
    vi.advanceTimersByTime(1000);
    await settle();

    // Then
    expect(alpha.hasAttribute('data-removable')).toBe(false);

    // When
    touch(alphaPill, 'touchstart');
    vi.advanceTimersByTime(449);
    await settle();

    // Then
    expect(alpha.hasAttribute('data-removable')).toBe(false);

    // When
    vi.advanceTimersByTime(1);
    await settle();

    // Then
    expect(alpha.hasAttribute('data-removable')).toBe(true);

    // When: the tap that ends the press does not navigate.
    touch(alphaPill, 'touchend');
    const tap = click(alphaPill);

    // Then
    expect(tap.defaultPrevented).toBe(true);

    // When: a long press on another pill moves the reveal there.
    const betaPill = byTestId('landing-recent-pill', beta, Element);
    touch(betaPill, 'touchstart');
    vi.advanceTimersByTime(450);
    await settle();

    // Then
    expect(alpha.hasAttribute('data-removable')).toBe(false);
    expect(beta.hasAttribute('data-removable')).toBe(true);

    // When: a tap inside the recents keeps it.
    beta.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();

    // Then
    expect(beta.hasAttribute('data-removable')).toBe(true);

    // When: a tap anywhere else hides it.
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();

    // Then
    expect(beta.hasAttribute('data-removable')).toBe(false);
    expect(click(betaPill).defaultPrevented).toBe(false);
  });

  it("As a visitor, the page's document listener goes with it", async () => {
    // Given
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    recents.labels = ['alpha'];
    mount();
    await settle();
    const added = add.mock.calls.filter(([type]) => type === 'pointerdown');
    expect(added).toHaveLength(1);

    // When
    page?.dispose();
    page = null;

    // Then
    expect(remove).toHaveBeenCalledWith('pointerdown', added[0]?.[1]);
  });

  it("As a visitor, the auth and theme buttons sit in the page's corner, with their surfaces in the body", async () => {
    // When
    mount();
    await settle();

    // Then: the buttons, each in its item wrapper, always inline (there is
    // no topbar to collapse them into).
    const corner = byId('landing-auth');
    expect([...corner.children].map(el => (el as HTMLElement).dataset['item'])).toEqual(['auth', 'theme']);
    expect(query(corner, '[data-item="auth"] > #landing-auth-button', HTMLButtonElement).disabled).toBe(false);
    expect(query(corner, '[data-item="theme"] > #landing-theme-toggle')).not.toBeNull();
    expect(corner.querySelector('[data-collapsed]')).toBeNull();
    expect(document.getElementById('more-button')).toBeNull();
    // The menus render through portals, outside the page.
    expect(byId('landing-theme-popover').parentElement).toBe(document.body);
    expect(byId('landing-user-popover').parentElement).toBe(document.body);
    for (const id of ['landing-auth-button', 'landing-theme-toggle', 'landing-theme-popover', 'landing-user-popover']) {
      expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
    }
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("As a visitor, the corner's theme button opens its menu, and picking a theme applies it and closes the menu", async () => {
    // Given
    mount();
    await settle();

    // When
    click(byId('landing-theme-toggle'));
    await settle();

    // Then
    expect(byId('landing-theme-popover').hasAttribute('data-open')).toBe(true);
    expect(byId('landing-theme-toggle').getAttribute('aria-expanded')).toBe('true');

    // When
    click(query(document, '[data-theme-option="dark"]'));
    await settle();

    // Then
    expect(byId('landing-theme-popover').hasAttribute('data-open')).toBe(false);
    expect(query(document, '[data-theme-option="dark"]').getAttribute('aria-checked')).toBe('true');
    expect(byId('landing-theme-toggle').title).toBe('Appearance: Dark');
  });

  it('As a visitor, leaving the landing page takes its corner buttons and their menus with it', async () => {
    // Given
    mount();
    await settle();

    // When
    page?.dispose();
    page = null;
    await settle();

    // Then
    for (const id of ['landing-auth-button', 'landing-theme-toggle', 'landing-theme-popover', 'landing-user-popover']) {
      expect(document.getElementById(id)).toBeNull();
    }
  });
});
