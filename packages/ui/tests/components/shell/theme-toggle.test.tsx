// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeToggle } from '../../../src/components/shell/ThemeToggle.js';
import { initTheme } from '../../../src/theme-controller.js';
import { setBlockingModalActive } from '../../../src/state/topbar.js';
import { mouseClick, pointerPress, renderComponent, resetStores, settle } from '../../helpers/solid.js';
import { stubColorScheme } from '../../helpers/color-scheme.js';
import { moreRow, renderTopbar, tapMoreRow } from './topbar-harness.js';
import { mountLandingPage } from '../../helpers/landing.js';
import { byId } from '../../support.js';

// The landing page loads the recent names from the shared storage frame,
// which happy-dom would try to fetch.
vi.mock('../../../src/recent-labels.js', () => ({
  loadRecentLabels: () => Promise.resolve([]),
  forgetRecentLabel: () => Promise.resolve(),
}));

beforeEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-pref');
});

afterEach(() => {
  resetStores();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The button and menu of the instance whose ids start with `prefix`. */
function themeButton(prefix = ''): HTMLButtonElement {
  return byId(`${prefix}theme-toggle`, HTMLButtonElement);
}

function themePopover(prefix = ''): HTMLElement {
  return byId(`${prefix}theme-popover`);
}

function themeOption(pref: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`.theme-popover-option[data-theme-option="${pref}"]`);
}

function isOpen(prefix = ''): boolean {
  return themePopover(prefix).classList.contains('open');
}

/** The toggle, plus a button outside it, with a known stored theme and OS. */
async function renderToggle(
  stored: 'light' | 'dark' | 'system' | null,
  os: 'light' | 'dark',
): Promise<{ os: ReturnType<typeof stubColorScheme> }> {
  const scheme = stubColorScheme(os);
  if (stored !== null) {
    localStorage.setItem('dotli-theme', stored);
  }
  renderComponent(() => (
    <div>
      <ThemeToggle />
      <button id="outside" type="button">
        Outside
      </button>
    </div>
  ));
  await settle();
  initTheme();
  await settle();
  return { os: scheme };
}

/**
 * The toggle in a topbar with no room for it, so the bar has collapsed it
 * into the More menu. A collapsed button cannot take focus (CSS hides it),
 * which happy-dom, without the stylesheet, has to be told.
 */
async function renderCollapsedToggle(stored: 'light' | 'dark' | 'system', os: 'light' | 'dark'): Promise<void> {
  stubColorScheme(os);
  localStorage.setItem('dotli-theme', stored);
  await renderTopbar(() => <ThemeToggle />, 1);
  initTheme();
  await settle();
  themeButton().focus = () => undefined;
}

async function openThemeMenu(stored: 'light' | 'dark' | 'system', os: 'light' | 'dark'): Promise<HTMLButtonElement> {
  await renderToggle(stored, os);
  mouseClick(themeButton());
  await settle();
  return themeButton();
}

/** Open the menu from the keyboard: Enter on the focused theme button. */
async function openThemeMenuWithKeyboard(
  stored: 'light' | 'dark' | 'system',
  os: 'light' | 'dark',
): Promise<HTMLButtonElement> {
  await renderToggle(stored, os);
  themeButton().focus();
  const event = await pressThemeKey('Enter');
  expect(event.defaultPrevented).toBe(true);
  expect(isOpen()).toBe(true);
  return themeButton();
}

async function pressThemeKey(key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? themePopover()).dispatchEvent(event);
  await settle();
  return event;
}

describe('ThemeToggle', () => {
  it('As a dotli user, the theme button and menu keep their ids, roles and labels', async () => {
    // Given
    await renderToggle('dark', 'dark');

    // Then
    const btn = themeButton();
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-controls')).toBe('theme-popover');
    expect(['sun', 'moon', 'system'].map(icon => document.querySelector(`.theme-icon-${icon}`)?.parentElement)).toEqual(
      [btn, btn, btn],
    );
    const popover = themePopover();
    expect(popover.className).toBe('more-popover theme-popover');
    expect(popover.getAttribute('role')).toBe('menu');
    expect(popover.getAttribute('aria-label')).toBe('Theme');
    expect(popover.getAttribute('tabindex')).toBe('-1');
    const options = Array.from(popover.querySelectorAll<HTMLButtonElement>('.theme-popover-option'));
    expect(options.map(o => o.dataset['themeOption'])).toEqual(['light', 'dark', 'system']);
    expect(options.map(o => o.textContent)).toEqual(['Light', 'Dark', 'System']);
    for (const option of options) {
      expect(option.className).toBe('more-row theme-popover-option');
      expect(option.getAttribute('role')).toBe('menuitemradio');
      expect(option.getAttribute('tabindex')).toBe('-1');
    }
  });

  it('As a dotli user, the theme button opens a menu with the current theme checked', async () => {
    // Given
    await renderToggle('light', 'dark');
    const btn = themeButton();
    const popover = themePopover();

    // When
    mouseClick(btn);
    await settle();

    // Then
    expect(popover.id).toBe('theme-popover');
    expect(popover.classList.contains('open')).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(themeOption('light')?.getAttribute('aria-checked')).toBe('true');
    expect(themeOption('dark')?.getAttribute('aria-checked')).toBe('false');
    expect(themeOption('system')?.getAttribute('aria-checked')).toBe('false');
    // A pointer opening focuses the menu itself, as in Radix DropdownMenu.
    expect(document.activeElement).toBe(popover);
    expect(btn.title).toBe('Theme: Light');
    expect(btn.getAttribute('aria-label')).toBe('Theme: Light');
  });

  it('As a dotli user, clicking the theme button again closes the menu', async () => {
    // Given
    const btn = await openThemeMenu('dark', 'dark');

    // When
    btn.click();
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('As a dotli user, I select Dark from the theme menu and it applies and persists', async () => {
    // Given
    const btn = await openThemeMenu('light', 'light');
    const popover = themePopover();

    // When
    themeOption('dark')?.click();
    await settle();

    // Then
    expect(localStorage.getItem('dotli-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme-pref')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(themeOption('dark')?.getAttribute('aria-checked')).toBe('true');
    expect(themeOption('light')?.getAttribute('aria-checked')).toBe('false');
    expect(popover.classList.contains('open')).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(btn);
    expect(btn.title).toBe('Theme: Dark');
    expect(btn.getAttribute('aria-label')).toBe('Theme: Dark');
  });

  it('As a dotli user, I select System from the theme menu and the theme resolves from the OS', async () => {
    // Given
    await openThemeMenu('dark', 'light');

    // When
    themeOption('system')?.click();
    await settle();

    // Then
    expect(localStorage.getItem('dotli-theme')).toBe('system');
    expect(document.documentElement.getAttribute('data-theme-pref')).toBe('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(themeButton().title).toBe('Theme: System');
  });

  it('As a keyboard user, Enter on the theme button opens the menu on its first option, whichever is checked', async () => {
    // When
    await openThemeMenuWithKeyboard('system', 'dark');

    // Then: Radix DropdownMenu focuses the first item, not the checked one.
    expect(document.activeElement).toBe(themeOption('light'));
    expect(themeOption('system')?.getAttribute('aria-checked')).toBe('true');
  });

  it('As a keyboard user, I press ArrowDown in the theme menu and focus moves to the next option', async () => {
    // Given
    await openThemeMenuWithKeyboard('light', 'dark');

    // When
    const event = await pressThemeKey('ArrowDown');

    // Then
    expect(document.activeElement).toBe(themeOption('dark'));
    expect(event.defaultPrevented).toBe(true);
  });

  it('As a keyboard user, I press ArrowDown on the last theme option and focus wraps to the first', async () => {
    // Given
    await openThemeMenuWithKeyboard('system', 'dark');
    await pressThemeKey('End');

    // When
    await pressThemeKey('ArrowDown');

    // Then
    expect(document.activeElement).toBe(themeOption('light'));
  });

  it('As a keyboard user, I press ArrowUp on the first theme option and focus wraps to the last', async () => {
    // Given
    await openThemeMenuWithKeyboard('light', 'dark');

    // When
    await pressThemeKey('ArrowUp');

    // Then
    expect(document.activeElement).toBe(themeOption('system'));
  });

  it('As a keyboard user, I press Home in the theme menu and focus moves to the first option', async () => {
    // Given
    await openThemeMenuWithKeyboard('system', 'dark');
    await pressThemeKey('End');

    // When
    await pressThemeKey('Home');

    // Then
    expect(document.activeElement).toBe(themeOption('light'));
  });

  it('As a keyboard user, I press End in the theme menu and focus moves to the last option', async () => {
    // Given
    await openThemeMenuWithKeyboard('light', 'dark');

    // When
    await pressThemeKey('End');

    // Then
    expect(document.activeElement).toBe(themeOption('system'));
  });

  it('As a keyboard user, typing a letter in the theme menu focuses the option starting with it', async () => {
    // Given
    await openThemeMenuWithKeyboard('light', 'dark');

    // When
    const event = await pressThemeKey('s');

    // Then
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(themeOption('system'));

    // When
    await pressThemeKey('D');

    // Then
    expect(document.activeElement).toBe(themeOption('dark'));
  });

  it('As a mouse user whose click left focus on the theme button, the menu still takes focus', async () => {
    // Given: a browser that focuses a button on click.
    await renderToggle('dark', 'dark');
    themeButton().focus();

    // When
    mouseClick(themeButton());
    await settle();

    // Then
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(themePopover());

    // When: the arrow keys work from the menu itself.
    await pressThemeKey('ArrowDown');

    // Then
    expect(document.activeElement).toBe(themeOption('light'));
  });

  it('As a keyboard user, I press Escape in the theme menu and it closes without changing the theme', async () => {
    // Given
    const btn = await openThemeMenu('light', 'dark');

    // When
    await pressThemeKey('Escape');

    // Then
    expect(isOpen()).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(btn);
    expect(localStorage.getItem('dotli-theme')).toBe('light');
  });

  it('As a keyboard user, I press Tab in the theme menu and nothing happens: focus stays in the open menu', async () => {
    // Given
    const btn = await openThemeMenuWithKeyboard('light', 'dark');
    const focused = document.activeElement;

    // When
    const event = await pressThemeKey('Tab');

    // Then: a modal menu prevents Tab, as Radix DropdownMenu does.
    expect(event.defaultPrevented).toBe(true);
    expect(isOpen()).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(focused);
  });

  it('As a keyboard user, I press Enter on a focused option and it selects that theme', async () => {
    // Given
    const btn = await openThemeMenuWithKeyboard('light', 'dark');
    await pressThemeKey('ArrowDown');

    // When: a focused button turns Enter into a click.
    (document.activeElement as HTMLButtonElement).click();
    await settle();

    // Then
    expect(localStorage.getItem('dotli-theme')).toBe('dark');
    expect(document.activeElement).toBe(btn);
  });

  it('As a dotli user, clicking outside closes the theme menu', async () => {
    // Given
    const btn = await openThemeMenu('dark', 'dark');

    // When
    pointerPress(byId('outside'));
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('As a dotli user, a click outside the theme menu only closes it: the click does not reach what is underneath', async () => {
    // Given
    await openThemeMenu('dark', 'dark');
    const outside = byId('outside');
    const clicks = vi.fn();
    outside.addEventListener('click', clicks);

    // When
    pointerPress(outside);
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(outside);
  });

  it('As a dotli user, the theme menu closes when a blocking modal comes up', async () => {
    // Given
    const btn = await openThemeMenu('dark', 'dark');

    // When
    setBlockingModalActive(true);
    await settle();

    // Then
    expect(isOpen()).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it("As a mobile user, the More menu's Theme row opens the theme menu", async () => {
    // Given: the bar has collapsed the theme button into the More menu.
    await renderCollapsedToggle('dark', 'dark');

    // When
    await tapMoreRow('theme');

    // Then
    expect(byId('more-popover').classList.contains('open')).toBe(false);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(themePopover());
  });

  it('As a keyboard user on a phone, choosing Theme in the More menu with the keyboard opens the theme menu on its first option', async () => {
    // Given
    await renderCollapsedToggle('dark', 'dark');
    byId('more-button').focus();

    // When: Enter opens the More menu, ArrowDown reaches Theme, and Enter
    // picks it (the browser fires the row's click, with detail 0).
    await pressThemeKey('Enter');
    document.activeElement?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    const themeRow = moreRow('theme');
    while (document.activeElement !== themeRow) {
      await pressThemeKey('ArrowDown');
    }
    await pressThemeKey('Enter');
    themeRow.click();
    await settle();

    // Then
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(themeOption('light'));
  });

  it('As a mobile user, the theme menu I opened from the More menu takes focus, and Escape hands it back to the More button', async () => {
    // Given
    await renderCollapsedToggle('dark', 'dark');

    // When
    await tapMoreRow('theme');

    // Then: the theme menu took focus, and its keys work.
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(themePopover());
    await pressThemeKey('ArrowDown');
    expect(document.activeElement).toBe(themeOption('light'));

    // When
    await pressThemeKey('Escape');

    // Then
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byId('more-button'));
  });

  it('As a dotli user whose browser blocks storage, picking a theme still applies it and closes the menu', async () => {
    // Given
    await openThemeMenu('light', 'light');
    const blocked = (): never => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });

    // When
    themeOption('dark')?.click();
    await settle();

    // Then
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(themeButton().title).toBe('Theme: Dark');
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(themeButton());
  });

  it('As a mobile user, picking a theme while the bar has collapsed the theme button hands focus to the More button', async () => {
    // Given
    await renderCollapsedToggle('dark', 'dark');
    await tapMoreRow('theme');

    // When
    themeOption('light')?.click();
    await settle();

    // Then
    expect(localStorage.getItem('dotli-theme')).toBe('light');
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byId('more-button'));
  });

  it("As a visitor on the landing page, the page's own theme button and menu work in its corner", async () => {
    // Given: the landing page renders its own theme button, outside any
    // topbar, and the menu in the body.
    stubColorScheme('dark');
    localStorage.setItem('dotli-theme', 'light');
    const landing = mountLandingPage();
    await settle();
    initTheme();
    await settle();
    const btn = themeButton('landing-');
    expect(btn.closest('#landing-auth')).not.toBeNull();
    expect(themePopover('landing-').parentElement).toBe(document.body);

    // When
    mouseClick(btn);
    await settle();

    // Then
    expect(isOpen('landing-')).toBe(true);
    expect(document.activeElement).toBe(themePopover('landing-'));

    // When
    await pressThemeKey('ArrowDown');

    // Then
    expect(document.activeElement).toBe(themeOption('light'));

    // When
    themeOption('dark')?.click();
    await settle();

    // Then
    expect(localStorage.getItem('dotli-theme')).toBe('dark');
    expect(isOpen('landing-')).toBe(false);
    expect(document.activeElement).toBe(btn);
    landing.dispose();
  });

  it("As a dotli user, the System option's label follows the store after an OS change", async () => {
    // Given
    const { os } = await renderToggle(null, 'dark');

    // When
    os.set('light');
    await settle();

    // Then
    expect(themeButton().title).toBe('Theme: System');
    expect(themeOption('system')?.getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
