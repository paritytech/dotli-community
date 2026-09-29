// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The shell islands chunk (components/shell/islands.tsx) swapping its live
// components in for the static markup of the real prerendered shell
// (helpers/shell-ssr.ts), which the page shows as static HTML until then, as
// the host boots. The topbar's action group is one island (`topbar`): it
// swaps `#topbar-actions` in place, and its items' surfaces render through
// portals into the body, taking the static ones out of the page.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disposeAppRoot } from '../../../src/mount/app-roots.js';
import { flush } from 'solid-js';
import { renderShellOnServer } from '../../helpers/shell-ssr.js';
import { stubColorScheme } from '../../helpers/color-scheme.js';
import { mountIslands } from '../../../src/components/shell/islands.js';
import { initTheme } from '../../../src/theme-controller.js';
import { resetAllStoresForTests } from '../../../src/state/create-store.js';
import { setTopbarVisible } from '../../../src/state/topbar.js';
import { setAuthState, setLoggedIn } from '../../../src/state/auth.js';
import { updateAuthModal } from '../../../src/state/auth-modal.js';
import { normalized, oldAuthButton, oldModal, oldUserPopover } from './old-auth-markup.js';
import { oldPermissionsBackdrop, oldPermissionsButton, oldPermissionsPopover } from './old-permissions-markup.js';
import { oldChainsButton, oldChainsPopover } from './old-chains-markup.js';
import { oldModeBackdrop, oldModeButton, oldModePopover } from './old-settings-markup.js';
import { initSettingsStore } from '../../../src/state/settings.js';
import { ITEM_WIDTH, moreRow, stubTopbarLayout, tapMoreRow } from './topbar-harness.js';
import { mouseClick, pointerPress } from '../../helpers/solid.js';
import { mountLandingPage } from '../../helpers/landing.js';
import { showLanding } from '../../../src/landing/load.js';
import { TOPBAR_ACTIONS_ID } from '../../../src/mount/topbar-ids.js';
import { registerPermissionAuthorizationProvider } from '../../../src/permissions.js';
import { setChainsButtonVisible } from '../../../src/topbar.js';
import { setProductLoaded } from '../../../src/state/product.js';
import { setVerificationShieldState, showLocalhostPill, showProductPill } from '../../../src/state/url-pill.js';
import type * as ThemeToggleModule from '../../../src/components/shell/ThemeToggle.js';
import { byId } from '../../support.js';
import { nth } from '../../helpers/nth.js';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../../../metrics/src/sentry.js', () => sentry);
// The landing page loads the recent names from the shared storage frame,
// which happy-dom would try to fetch.
vi.mock('../../../src/recent-labels.js', () => ({
  loadRecentLabels: () => Promise.resolve([]),
  forgetRecentLabel: () => Promise.resolve(),
}));

// Lets a test make the theme island throw while it renders, or later, once
// it has swapped in (`breakLater`), and count its disposals.
const themeIsland = vi.hoisted(() => ({
  broken: false,
  breakLater: null as (() => void) | null,
  disposed: 0,
}));
vi.mock('../../../src/components/shell/ThemeToggle.js', async importOriginal => {
  const actual = await importOriginal<typeof ThemeToggleModule>();
  const { createSignal, onCleanup } = await import('solid-js');
  return {
    ThemeToggle: () => {
      if (themeIsland.broken) {
        throw new Error('the theme island broke');
      }
      const [late, setLate] = createSignal(false, { ownedWrite: true });
      themeIsland.breakLater = () => setLate(true);
      onCleanup(() => {
        themeIsland.disposed += 1;
      });
      return [
        actual.ThemeToggle(),
        () => {
          if (late()) {
            throw new Error('the theme island broke later');
          }
          return null;
        },
      ];
    },
  };
});

const THEME_IDS = ['theme-toggle', 'theme-popover'];

let serverHtml = '';
let landing: ReturnType<typeof mountLandingPage> | null = null;

function themeOption(pref: string): HTMLElement | null {
  return document.querySelector(`.theme-popover-option[data-theme-option="${pref}"]`);
}

/** How many elements in the document carry `id`. */
function countById(id: string): number {
  return document.querySelectorAll(`[id="${id}"]`).length;
}

/** Where `el` sits: its parent and its index among the parent's children. */
function placeOf(el: Element): { parent: Element | null; index: number } {
  const parent = el.parentElement;
  return {
    parent,
    index: parent === null ? -1 : [...parent.children].indexOf(el),
  };
}

/**
 * `el` without what differs by design between the prerender and the island:
 * the labels and checks the island renders from the theme store (the
 * prerender shows no preference).
 */
function withoutStoreState(el: Element): Element {
  const copy = el.cloneNode(true) as Element;
  for (const node of [copy, ...copy.querySelectorAll('*')]) {
    if (node.id === 'theme-toggle') {
      node.setAttribute('title', 'Theme');
      node.setAttribute('aria-label', 'Theme');
    }
    if (node.hasAttribute('aria-checked')) {
      node.setAttribute('aria-checked', 'false');
    }
    // The island sets its style property by property, the prerender as one
    // string: compare the declarations, not how they are spelled.
    if (node instanceof HTMLElement && node.hasAttribute('style')) {
      node.setAttribute('style', node.style.cssText);
    }
  }
  return copy;
}

/**
 * The static `el` plus the ARIA of a Radix DropdownMenu, which only the
 * island renders: the menus take focus, the More button announces its menu,
 * and the More flyout is a menu named by its button, of menu items.
 */
function withMenuAria(el: Element): Element {
  const copy = el.cloneNode(true) as Element;
  if (copy.id === 'theme-popover') {
    copy.setAttribute('tabindex', '-1');
  } else if (copy.id === 'more-button') {
    copy.setAttribute('aria-haspopup', 'menu');
  } else if (copy.id === 'more-popover') {
    copy.setAttribute('role', 'menu');
    copy.setAttribute('aria-labelledby', 'more-button');
    copy.setAttribute('tabindex', '-1');
    for (const row of copy.querySelectorAll('.more-row')) {
      row.setAttribute('role', 'menuitem');
      row.setAttribute('tabindex', '-1');
    }
  }
  return copy;
}

/**
 * Each of `ids`, buttons of the static action group, is on the page once, on
 * a new element inside the live group, the static one gone.
 */
function expectSwapped(ids: string[], before: Element[]): void {
  for (const [i, id] of ids.entries()) {
    const fresh = byId(id);
    expect(countById(id)).toBe(1);
    expect(fresh).not.toBe(before[i]);
    expect(before[i]?.isConnected).toBe(false);
    expect(byId(TOPBAR_ACTIONS_ID).contains(fresh)).toBe(true);
  }
}

/**
 * Each of `ids`, surfaces the topbar island renders through portals (the
 * static shell has none), is on the page once, in the body.
 */
function expectPortaled(ids: string[]): void {
  for (const id of ids) {
    expect(countById(id)).toBe(1);
    expect(byId(id).parentElement).toBe(document.body);
  }
}

const FIXTURE = readFileSync(resolve(import.meta.dirname, 'original-shell.html'), 'utf8');

/**
 * The element with `id` in the shell markup the fixture froze: for a popover,
 * the markup the live one matches, now that the prerender has none.
 */
function fixture(id: string): Element {
  const template = document.createElement('template');
  template.innerHTML = FIXTURE;
  const el = template.content.querySelector(`[id="${id}"]`);
  if (el === null) {
    throw new Error(`the fixture has no #${id}`);
  }
  return normalized(el);
}

/** Retire the topbar's action group as the landing loader does. */
function retireActionGroup(): void {
  document.getElementById(TOPBAR_ACTIONS_ID)?.remove();
}

async function flushAll(): Promise<void> {
  flush();
  await Promise.resolve();
  flush();
}

describe('shell islands', () => {
  beforeAll(async () => {
    serverHtml = await renderShellOnServer();
  });

  beforeEach(async () => {
    vi.unstubAllGlobals();
    stubColorScheme('dark');
    localStorage.clear();
    themeIsland.broken = false;
    themeIsland.breakLater = null;
    themeIsland.disposed = 0;
    sentry.captureException.mockClear();
    document.body.innerHTML = `<div id="shell" style="display: contents">${serverHtml}</div>`;
    await flushAll();
  });

  afterEach(() => {
    landing?.dispose();
    landing = null;
    disposeAppRoot('page');
    disposeAppRoot('island:topbar');
    disposeAppRoot('island:url-pill');
    disposeAppRoot('island:offline-banner');
    disposeAppRoot('island:auth-modal');
    resetAllStoresForTests();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('As a dotli user, the static action group is swapped in place for the live one, the theme toggle matching its static markup and its menu the frozen shell markup, one element per id, with no warning', async () => {
    // Given: the prerendered static group, as the page shows it before the
    // islands load.
    expect(byId('shell').contains(byId('theme-toggle'))).toBe(true);
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const staticGroup = byId(TOPBAR_ACTIONS_ID);
    const place = placeOf(staticGroup);
    const staticToggle = byId('theme-toggle');
    const markup = THEME_IDS.map(id =>
      withMenuAria(withoutStoreState(id === 'theme-toggle' ? staticToggle : fixture(id))),
    );
    expect(countById('theme-popover')).toBe(0);

    // When
    const failed = mountIslands();
    await flushAll();

    // Then
    expect(failed).toEqual([]);
    const liveGroup = byId(TOPBAR_ACTIONS_ID);
    expect(countById(TOPBAR_ACTIONS_ID)).toBe(1);
    expect(liveGroup).not.toBe(staticGroup);
    expect(staticGroup.isConnected).toBe(false);
    expect(placeOf(liveGroup)).toEqual(place);
    expect(liveGroup.hasAttribute('data-collapsible')).toBe(true);
    expectSwapped(['theme-toggle'], [staticToggle]);
    expectPortaled(['theme-popover']);
    for (const [i, id] of THEME_IDS.entries()) {
      expect(normalized(withoutStoreState(byId(id))).isEqualNode(nth(markup, i))).toBe(true);
    }
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('As a returning user, the swapped-in theme toggle shows my stored theme and its menu applies a new one', async () => {
    // Given
    localStorage.setItem('dotli-theme', 'light');
    mountIslands();
    await flushAll();

    // When: initTopBar applies the stored theme.
    initTheme();
    await flushAll();

    // Then
    const btn = byId('theme-toggle');
    expect(btn.title).toBe('Theme: Light');
    expect(themeOption('light')?.getAttribute('aria-checked')).toBe('true');

    // When
    mouseClick(btn);
    await flushAll();

    // Then: a pointer opening focuses the menu itself.
    expect(byId('theme-popover').classList.contains('open')).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(byId('theme-popover'));

    // When
    themeOption('dark')?.click();
    await flushAll();

    // Then
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(btn.title).toBe('Theme: Dark');
    expect(themeOption('dark')?.getAttribute('aria-checked')).toBe('true');
    expect(byId('theme-popover').classList.contains('open')).toBe(false);
  });

  it("As a visitor on the landing page, the islands leave out the action group the landing loader took away, and the page's own theme toggle works", async () => {
    // Given: the landing loader took the action group out of the page, and
    // the landing page renders its own auth and theme buttons.
    retireActionGroup();
    landing = mountLandingPage();
    await flushAll();
    const landingAuth = byId('landing-auth');
    const pageToggle = byId('theme-toggle');

    // When
    const failed = mountIslands();
    await flushAll();

    // Then
    expect(failed).toEqual([]);
    expect(countById(TOPBAR_ACTIONS_ID)).toBe(0);
    for (const id of ['auth-button', ...THEME_IDS, 'user-popover', 'mode-popover', 'more-button']) {
      expect(countById(id)).toBe(id === 'mode-popover' || id === 'more-button' ? 0 : 1);
    }
    expect(byId('theme-toggle')).toBe(pageToggle);
    expect(landingAuth.contains(pageToggle)).toBe(true);

    // When
    mouseClick(byId('theme-toggle'));
    await flushAll();

    // Then
    expect(byId('theme-popover').classList.contains('open')).toBe(true);
    expect(document.activeElement).toBe(byId('theme-popover'));
  });

  it('As a keyboard user who had focused the static theme button, focus stays on the button once the island swaps in', async () => {
    // Given
    const staticButton = byId('theme-toggle');
    staticButton.focus();
    expect(document.activeElement).toBe(staticButton);

    // When
    mountIslands();
    await flushAll();

    // Then
    expect(byId('theme-toggle')).not.toBe(staticButton);
    expect(document.activeElement).toBe(byId('theme-toggle'));
  });

  it('As a keyboard user focused on a static element with an id, focus moves to the live element with that id, wherever it sits', async () => {
    // Given: a focusable static element whose live counterpart sits
    // elsewhere in the island (here the shield button, which the live pill
    // nests inside `#url-pill`).
    showProductPill('app', '.dot.li');
    setVerificationShieldState('verified');
    const staticShield = document.createElement('button');
    staticShield.id = 'verification-shield';
    byId('topbar-url').append(staticShield);
    staticShield.focus();
    expect(document.activeElement).toBe(staticShield);

    // When
    mountIslands();
    await flushAll();

    // Then
    expect(staticShield.isConnected).toBe(false);
    expect(byId('verification-shield')).not.toBe(staticShield);
    expect(document.activeElement).toBe(byId('verification-shield'));
  });

  it('As a keyboard user focused on a static node whose live counterpart is not focusable, focus moves to the first focusable element in it', async () => {
    // Given: the live `#topbar-url` is a plain div, not focusable, holding
    // the shield button.
    showProductPill('app', '.dot.li');
    setVerificationShieldState('verified');
    const staticUrl = byId('topbar-url');
    staticUrl.setAttribute('tabindex', '-1');
    staticUrl.focus();
    expect(document.activeElement).toBe(staticUrl);

    // When
    mountIslands();
    await flushAll();

    // Then
    expect(staticUrl.isConnected).toBe(false);
    expect(byId('topbar-url').hasAttribute('tabindex')).toBe(false);
    expect(document.activeElement).toBe(byId('verification-shield'));
  });

  it('As a keyboard user focused on a static node whose live counterpart has nothing focusable, the unfocusable live node is not focused', async () => {
    // Given: the live banner is a status region with nothing to focus.
    const staticBanner = byId('offline-banner');
    staticBanner.setAttribute('tabindex', '-1');
    staticBanner.focus();
    expect(document.activeElement).toBe(staticBanner);

    // When
    mountIslands();
    await flushAll();

    // Then
    const liveBanner = byId('offline-banner');
    expect(liveBanner).not.toBe(staticBanner);
    expect(document.activeElement).not.toBe(liveBanner);
    expect(liveBanner.contains(document.activeElement)).toBe(false);
  });

  it('As a dotli user, a topbar item that throws while rendering leaves the whole static action group in place and renders no popover, reported once', async () => {
    // Given
    themeIsland.broken = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ids = [TOPBAR_ACTIONS_ID, 'theme-toggle', 'more-button'];
    const before = ids.map(id => byId(id));

    // When
    const failed = mountIslands();
    await flushAll();

    // Then
    expect(failed).toEqual(['topbar']);
    for (const [i, id] of ids.entries()) {
      expect(byId(id)).toBe(before[i]);
      expect(countById(id)).toBe(1);
    }
    // Nothing of the island stays: no popover.
    for (const id of ['theme-popover', 'more-popover', 'user-popover', 'mode-popover']) {
      expect(countById(id)).toBe(0);
    }
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'the theme island broke' }),
      { root: 'island:topbar' },
    );
  });

  it('As a dotli user, a topbar item that throws after the swap disposes the island once, the static group comes back where it was with focus, its live popovers gone, and the loader hears of it', async () => {
    // Given
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ids = [TOPBAR_ACTIONS_ID, 'theme-toggle'];
    const before = ids.map(id => byId(id));
    const places = ids.map(id => placeOf(byId(id)));
    const failures: string[] = [];
    expect(mountIslands(name => failures.push(name))).toEqual([]);
    await flushAll();
    const live = ids.map(id => byId(id));
    expect(live[0]).not.toBe(before[0]);
    const livePopovers = ['theme-popover', 'user-popover', 'mode-popover'].map(id => byId(id));
    byId('theme-toggle').focus();

    // When
    themeIsland.breakLater?.();
    await flushAll();
    await Promise.resolve();

    // Then
    for (const [i, id] of ids.entries()) {
      expect(byId(id)).toBe(before[i]);
      expect(countById(id)).toBe(1);
      expect(live[i]?.isConnected).toBe(false);
      expect(placeOf(byId(id))).toEqual(places[i]);
    }
    // The live popovers went with the island; the static shell has none.
    for (const popover of livePopovers) {
      expect(popover.isConnected).toBe(false);
      expect(countById(popover.id)).toBe(0);
    }
    expect(document.activeElement).toBe(before[ids.indexOf('theme-toggle')]);
    expect(themeIsland.disposed).toBe(1);
    expect(failures).toEqual(['topbar']);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'the theme island broke later' }),
      { root: 'island:topbar' },
    );
  });

  it('As a dotli user, an island that throws outside its error boundary is reported once, keeps its static markup and does not stop the other islands', async () => {
    // Given
    const staticBar = byId('topbar-url');
    const staticBanner = byId('offline-banner');
    const failure = new Error('the swap broke');
    vi.spyOn(staticBar, 'replaceWith').mockImplementation(() => {
      throw failure;
    });
    const staticToggle = byId('theme-toggle');

    // When
    const failed = mountIslands();
    await flushAll();

    // Then
    expect(failed).toEqual(['url-pill']);
    expect(byId('topbar-url')).toBe(staticBar);
    expect(countById('topbar-url')).toBe(1);
    expect(byId('theme-toggle')).not.toBe(staticToggle);
    expect(byId('offline-banner')).not.toBe(staticBanner);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(failure, {
      root: 'island:url-pill',
      kind: 'island_mount_error',
    });
  });

  it('As a dotli user, an island whose static node is missing from the page is reported once and the other islands still mount', async () => {
    // Given
    byId('offline-banner').remove();
    const staticToggle = byId('theme-toggle');
    const staticBar = byId('topbar-url');

    // When
    const failed = mountIslands();
    await flushAll();

    // Then
    expect(failed).toEqual(['offline-banner']);
    expect(countById('offline-banner')).toBe(0);
    expect(byId('theme-toggle')).not.toBe(staticToggle);
    expect(byId('topbar-url')).not.toBe(staticBar);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '[islands] island:offline-banner has no #offline-banner on the page',
      }),
      { root: 'island:offline-banner', kind: 'island_missing_node' },
    );
  });

  // ensureIslands mounts once per module, and reloading the module would
  // load a second Solid, so this is the file's only ensureIslands test.
  it('As a dotli user, a click on the theme button while the islands are still loading opens the menu once they mount, even when another island throws while mounting', async () => {
    // Given
    const { ensureIslands } = await import('../../../src/mount/load-islands.js');
    const staticBar = byId('topbar-url');
    vi.spyOn(staticBar, 'replaceWith').mockImplementation(() => {
      throw new Error('the swap broke');
    });
    const staticButton = byId('theme-toggle');

    // When
    const loading = ensureIslands();
    staticButton.click();
    await loading;
    await flushAll();

    // Then
    expect(byId('topbar-url')).toBe(staticBar);
    expect(byId('theme-toggle')).not.toBe(staticButton);
    expect(byId('theme-popover').classList.contains('open')).toBe(true);
    expect(byId('theme-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      root: 'island:url-pill',
      kind: 'island_mount_error',
    });
  });

  it("As a dotli user, the URL bar's static markup is swapped in place for the live pill, which matches it, with no warning", async () => {
    // Given
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const staticBar = byId('topbar-url');
    const place = placeOf(staticBar);
    const markup = withoutStoreState(staticBar);

    // When
    mountIslands();
    await flushAll();

    // Then
    const liveBar = byId('topbar-url');
    expect(countById('topbar-url')).toBe(1);
    expect(liveBar).not.toBe(staticBar);
    expect(staticBar.isConnected).toBe(false);
    expect(placeOf(liveBar)).toEqual(place);
    expect(withoutStoreState(liveBar).isEqualNode(markup)).toBe(true);
    expect(liveBar.matches(':empty')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('As a visitor of a product resolved before the islands loaded, the swapped-in pill shows it with its shield state', async () => {
    // Given: main.ts writes the store before the chunk arrives.
    showProductPill('app', '.dot.li');
    setVerificationShieldState('verified');

    // When
    mountIslands();
    await flushAll();

    // Then
    expect(countById('topbar-url')).toBe(1);
    expect(countById('url-pill')).toBe(1);
    expect(byId('topbar-url').querySelector('.dot-domain')?.textContent).toBe('app');
    expect(byId('verification-shield').classList.contains('verified')).toBe(true);
  });

  it('As a dotli user, the swapped-in pill follows the store and its shield opens', async () => {
    // Given
    mountIslands();
    await flushAll();

    // When
    showLocalhostPill('localhost:3000');
    await flushAll();

    // Then
    expect(byId('url-pill').classList.contains('localhost-pill')).toBe(true);
    expect(byId('topbar-url').querySelector('.dot-domain')?.textContent).toBe('localhost:3000');

    // When
    showProductPill('app', '.dot.li');
    await flushAll();
    byId('verification-shield').click();
    await flushAll();

    // Then
    expect(byId('verification-tooltip').classList.contains('open')).toBe(true);
    expect(byId('verification-shield').getAttribute('aria-expanded')).toBe('true');
  });

  it("As a dotli user online, the offline banner's hidden static markup is swapped in place, as the topbar's last child, for the live banner, with no warning", async () => {
    // Given
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const staticBanner = byId('offline-banner');
    expect(staticBanner.parentElement).toBe(byId('topbar'));
    expect(staticBanner.style.display).toBe('none');
    const place = placeOf(staticBanner);
    const markup = withoutStoreState(staticBanner);

    // When
    mountIslands();
    await flushAll();

    // Then
    const liveBanner = byId('offline-banner');
    expect(countById('offline-banner')).toBe(1);
    expect(liveBanner).not.toBe(staticBanner);
    expect(staticBanner.isConnected).toBe(false);
    expect(placeOf(liveBanner)).toEqual(place);
    expect(byId('topbar').lastElementChild).toBe(liveBanner);
    expect(withoutStoreState(liveBanner).isEqualNode(markup)).toBe(true);
    expect(liveBanner.style.display).toBe('none');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('As a user offline when the islands mount, the swapped-in banner shows, follows the connection and hides with the topbar', async () => {
    // Given
    let online = false;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);

    // When
    mountIslands();
    await flushAll();

    // Then
    expect(byId('offline-banner').style.display).toBe('block');

    // When
    setTopbarVisible(false);
    await flushAll();

    // Then
    expect(byId('offline-banner').style.display).toBe('none');

    // When
    setTopbarVisible(true);
    online = true;
    window.dispatchEvent(new Event('online'));
    await flushAll();

    // Then
    expect(byId('offline-banner').style.display).toBe('none');

    // When
    online = false;
    window.dispatchEvent(new Event('offline'));
    await flushAll();

    // Then
    expect(byId('offline-banner').style.display).toBe('block');
  });

  it('As a dotli user, the auth button, user popover and pairing modal are swapped for live islands their popovers rendered in the body, matching what the topbar rendered, one element per id, with no warning', async () => {
    // Given: the static button says it is connecting, disabled.
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const staticButton = byId('auth-button');
    expect(staticButton.hasAttribute('disabled')).toBe(true);
    expect(staticButton.getAttribute('aria-busy')).toBe('true');
    expect(staticButton.title).toBe('Connecting...');
    const staticModal = byId('auth-modal-backdrop');
    const modalPlace = placeOf(staticModal);
    expect(countById('user-popover')).toBe(0);

    // When
    mountIslands();
    await flushAll();

    // Then
    expectSwapped(['auth-button'], [staticButton]);
    expectPortaled(['user-popover']);
    expect(countById('auth-modal-backdrop')).toBe(1);
    expect(byId('auth-modal-backdrop')).not.toBe(staticModal);
    expect(placeOf(byId('auth-modal-backdrop'))).toEqual(modalPlace);
    const liveButton = byId('auth-button');
    expect(liveButton.hasAttribute('disabled')).toBe(false);
    expect(liveButton.hasAttribute('aria-busy')).toBe(false);
    // Logged out, it gains the trigger ARIA of the auth modal it opens.
    const loggedOut = oldAuthButton('logged-out');
    loggedOut.setAttribute('aria-haspopup', 'dialog');
    loggedOut.setAttribute('aria-expanded', 'false');
    loggedOut.setAttribute('aria-controls', 'auth-modal-backdrop');
    expect(normalized(liveButton).isEqualNode(normalized(loggedOut))).toBe(true);
    // The popover gains the role, name and tabindex of a Radix-style
    // non-modal popover.
    const popover = oldUserPopover({ username: '', hint: false, open: false });
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', 'Welcome back');
    popover.setAttribute('tabindex', '-1');
    expect(normalized(byId('user-popover')).isEqualNode(normalized(popover))).toBe(true);
    expect(
      normalized(byId('auth-modal-backdrop')).isEqualNode(
        normalized(
          oldModal({
            open: false,
            hint: 'Scan with Polkadot Mobile to connect',
            getAppHidden: true,
            body: { kind: 'empty' },
          }),
        ),
      ),
    ).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('As a returning user whose session and login came before the islands loaded, the swapped-in islands show them', async () => {
    // Given: what the eager auth controller keeps from boot on.
    setAuthState({
      tag: 'Connected',
      session: {
        connected: true,
        primaryUsername: 'alice',
        liteUsername: 'alice',
      },
    });
    setLoggedIn(true);
    updateAuthModal({
      open: true,
      productLabel: 'app.dot',
      reason: null,
      view: { kind: 'spinner' },
    });

    // When
    mountIslands();
    await flushAll();

    // Then
    expect(byId('auth-button').querySelector('.user-badge')?.textContent).toBe('AL');
    expect(byId('user-popover-username').textContent).toBe('alice');
    expect(byId('auth-modal-backdrop').classList.contains('open')).toBe(true);
    expect(byId('auth-modal-title').textContent).toBe('app.dot is asking you to sign in');
    // Its first control, as a Radix Dialog focuses.
    expect(document.activeElement).toBe(byId('auth-modal-close'));
  });

  it("As a visitor on the landing page, when the islands swap in before the page shows, the landing loader takes the live action group away, and the page's own auth and theme buttons work", async () => {
    // Given: the islands are live, then the landing loader runs.
    setAuthState({
      tag: 'Connected',
      session: { connected: true, liteUsername: 'pgherveou.04' },
    });
    setLoggedIn(true);
    const app = document.createElement('div');
    app.id = 'app';
    document.body.append(app);
    mountIslands();
    await flushAll();
    const liveGroup = byId(TOPBAR_ACTIONS_ID);

    // When
    await showLanding();
    await flushAll();

    // Then: one element per id, all the page's.
    expect(liveGroup.isConnected).toBe(false);
    expect(countById(TOPBAR_ACTIONS_ID)).toBe(0);
    const landingAuth = byId('landing-auth');
    for (const id of ['auth-button', 'theme-toggle']) {
      expect(countById(id)).toBe(1);
      expect(landingAuth.contains(byId(id))).toBe(true);
    }
    for (const id of ['theme-popover', 'user-popover']) {
      expect(countById(id)).toBe(1);
    }
    for (const id of ['more-button', 'chains-button', 'mode-popover', 'permissions-popover']) {
      expect(countById(id)).toBe(0);
    }

    // When
    mouseClick(byId('theme-toggle'));
    await flushAll();

    // Then
    expect(byId('theme-popover').classList.contains('open')).toBe(true);
    expect(document.activeElement).toBe(byId('theme-popover'));

    // When
    byId('auth-button').click();
    await flushAll();

    // Then
    expect(byId('user-popover').classList.contains('open')).toBe(true);
    expect(document.activeElement).toBe(byId('user-popover-disconnect'));
  });

  it("As a dotli user, the permissions button, backdrop and popover are swapped for the topbar island's live ones, their popovers rendered in the body, matching what the topbar rendered, one element per id, with no warning", async () => {
    // Given
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const staticButton = byId('permissions-button');

    // When
    mountIslands();
    await flushAll();

    // Then
    expectSwapped(['permissions-button'], [staticButton]);
    expectPortaled(['permissions-popover-backdrop', 'permissions-popover']);
    expect(
      normalized(byId('permissions-button')).isEqualNode(
        normalized(oldPermissionsButton({ open: false, hasGrants: false })),
      ),
    ).toBe(true);
    expect(
      normalized(byId('permissions-popover-backdrop')).isEqualNode(normalized(oldPermissionsBackdrop(false))),
    ).toBe(true);
    expect(
      normalized(byId('permissions-popover')).isEqualNode(
        normalized(oldPermissionsPopover({ open: false, list: { kind: 'empty' } })),
      ),
    ).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("As a mobile user, the More menu's Permissions row opens the swapped-in popover, and an app loaded before the islands shows its grants", async () => {
    // Given: an app with a grant, loaded before the islands, on a screen
    // with room for the account button and More only.
    const layout = stubTopbarLayout(2 * ITEM_WIDTH);
    const unregister = registerPermissionAuthorizationProvider('app.dot', {
      getPermissionAuthorizationStatuses: requests =>
        Promise.resolve(
          requests.map(request =>
            request.tag === 'Device' && request.value === 'Camera' ? 'Authorized' : 'NotDetermined',
          ),
        ),
      setPermissionAuthorizationStatus: async () => {},
    });
    setProductLoaded('app.dot', 'app.dot');

    try {
      // When
      mountIslands();
      await flushAll();
      // A real ResizeObserver reports the swapped-in group's size.
      layout.setRoom(2 * ITEM_WIDTH);
      await flushAll();

      // Then
      expect(byId('permissions-button').classList.contains('has-grants')).toBe(true);

      // When
      await tapMoreRow('permissions');
      await flushAll();
      await flushAll();

      // Then
      expect(byId('more-popover').classList.contains('open')).toBe(false);
      expect(byId('permissions-popover').classList.contains('open')).toBe(true);
      expect(byId('permissions-popover-backdrop').classList.contains('open')).toBe(true);
      expect(document.activeElement).toBe(byId('permissions-popover'));
      expect(byId('permissions-popover-status-Camera').textContent).toBe('Allowed');
    } finally {
      unregister();
    }
  });

  it("As a dotli user, the network button and popover are swapped for the topbar island's live ones, their popovers rendered in the body, matching what the topbar rendered, one element per id, with no warning", async () => {
    // Given
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const staticButton = byId('chains-button');

    // When
    mountIslands();
    await flushAll();

    // Then
    expectSwapped(['chains-button'], [staticButton]);
    expectPortaled(['chains-popover']);
    expect(
      normalized(byId('chains-button')).isEqualNode(normalized(oldChainsButton({ open: false, visible: false }))),
    ).toBe(true);
    expect(normalized(byId('chains-popover')).isEqualNode(normalized(oldChainsPopover({ open: false })))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('As a visitor whose product rendered before the islands loaded, the swapped-in network button shows, keeps following the host and opens', async () => {
    // Given: the host reveals the button on the static markup.
    setChainsButtonVisible(true);
    expect(byId('chains-button').classList.contains('visible')).toBe(true);

    // When
    mountIslands();
    await flushAll();

    // Then
    expect(
      normalized(byId('chains-button')).isEqualNode(normalized(oldChainsButton({ open: false, visible: true }))),
    ).toBe(true);

    // When
    byId('chains-button').click();
    await flushAll();

    // Then
    expect(byId('chains-popover').classList.contains('open')).toBe(true);
    expect(document.activeElement).toBe(byId('chains-popover'));
    expect(byId('chains-popover').querySelector('.chains-status')?.textContent).toBe('Starting');

    // When
    setChainsButtonVisible(false);
    await flushAll();

    // Then
    expect(byId('chains-button').classList.contains('visible')).toBe(false);
  });

  it("As a dotli user, the settings button, backdrop and popover are swapped for the topbar island's live ones, their popovers rendered in the body, matching what the topbar rendered, one element per id, with no warning", async () => {
    // Given: the host seeds the settings store at boot, before the islands.
    initSettingsStore();
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const staticButton = byId('mode-button');

    // When
    mountIslands();
    await flushAll();

    // Then
    expectSwapped(['mode-button'], [staticButton]);
    expectPortaled(['mode-popover-backdrop', 'mode-popover']);
    expect(
      normalized(byId('mode-button')).isEqualNode(normalized(oldModeButton({ open: false, verified: true }))),
    ).toBe(true);
    expect(normalized(byId('mode-popover-backdrop')).isEqualNode(normalized(oldModeBackdrop({ open: false })))).toBe(
      true,
    );
    expect(normalized(byId('mode-popover')).isEqualNode(normalized(oldModePopover({ open: false })))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();

    // When
    byId('mode-button').click();
    await flushAll();

    // Then
    expect(byId('mode-popover').classList.contains('open')).toBe(true);
    expect(byId('mode-popover-backdrop').classList.contains('open')).toBe(true);
    expect(document.activeElement).toBe(byId('mode-popover').querySelector('button'));
    expect(byId('mode-popover').querySelector('.mode-popover-sheet-title')?.textContent).toBe('Settings');
  });

  it('As a dotli user, the More button is swapped for a live one matching its static markup, with a flyout matching the frozen shell markup, both at the end of the live group, with no rows while everything fits', async () => {
    // Given
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const staticButton = byId('more-button');
    const markup = [withMenuAria(withoutStoreState(staticButton)), withMenuAria(fixture('more-popover'))];
    expect(countById('more-popover')).toBe(0);

    // When
    const failed = mountIslands();
    await flushAll();

    // Then
    expect(failed).toEqual([]);
    expectSwapped(['more-button'], [staticButton]);
    expect(countById('more-popover')).toBe(1);
    for (const [i, id] of ['more-button', 'more-popover'].entries()) {
      const fresh = withoutStoreState(byId(id));
      // Only the live bar knows whether anything is collapsed.
      fresh.classList.remove('topbar-more-idle');
      expect(fresh.isEqualNode(nth(markup, i))).toBe(true);
    }
    const group = byId(TOPBAR_ACTIONS_ID);
    expect([...group.children].slice(-2)).toEqual([byId('more-button'), byId('more-popover')]);
    expect(document.querySelectorAll('#more-popover .more-row')).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("As a mobile user, the swapped-in More menu's Theme and Settings rows open the swapped-in theme menu and settings popover", async () => {
    // Given: room for the account button and More only.
    initSettingsStore();
    const layout = stubTopbarLayout(2 * ITEM_WIDTH);
    mountIslands();
    await flushAll();
    // A real ResizeObserver reports the swapped-in group's size.
    layout.setRoom(2 * ITEM_WIDTH);
    await flushAll();

    // When
    await tapMoreRow('theme');
    await flushAll();

    // Then
    expect(byId('more-popover').classList.contains('open')).toBe(false);
    expect(byId('theme-popover').classList.contains('open')).toBe(true);

    // When: the More button's tap is outside the theme menu, a modal menu,
    // so it only closes the menu: its click is swallowed.
    pointerPress(byId('more-button'));
    await flushAll();

    // Then
    expect(byId('theme-popover').classList.contains('open')).toBe(false);
    expect(byId('more-popover').classList.contains('open')).toBe(false);

    // When
    await tapMoreRow('settings');
    await flushAll();

    // Then
    expect(byId('theme-popover').classList.contains('open')).toBe(false);
    expect(byId('more-popover').classList.contains('open')).toBe(false);
    expect(byId('mode-popover').classList.contains('open')).toBe(true);
  });

  it("As a mobile user, once a product is on screen the swapped-in More menu's Network row opens the swapped-in network panel", async () => {
    // Given
    stubTopbarLayout(2 * ITEM_WIDTH);
    mountIslands();
    await flushAll();
    expect(document.querySelector('#more-popover .more-row[data-item="network"]')).toBeNull();

    // When
    setChainsButtonVisible(true);
    await flushAll();

    // Then
    expect(moreRow('network').textContent).toBe('Network');

    // When
    await tapMoreRow('network');
    await flushAll();

    // Then
    expect(byId('more-popover').classList.contains('open')).toBe(false);
    expect(byId('more-button').getAttribute('aria-expanded')).toBe('false');
    expect(byId('chains-popover').classList.contains('open')).toBe(true);
    expect(byId('chains-button').getAttribute('aria-expanded')).toBe('true');
  });
});
