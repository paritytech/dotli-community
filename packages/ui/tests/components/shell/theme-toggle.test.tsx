// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeToggle } from '../../../src/components/shell/ThemeToggle.js';
import { getThemeState } from '../../../src/state/theme.js';
import { initTheme } from '../../../src/theme-controller.js';
import { mouseClick, renderComponent, resetStores, settle } from '../../helpers/solid.js';
import { stubColorScheme } from '../../helpers/color-scheme.js';
import { stubPhoneViewport } from '../../helpers/viewport.js';
import { renderTopbar, tapMoreRow } from './topbar-harness.js';
import { byId, byTestId, query } from '../../support.js';

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

function themeButton(): HTMLButtonElement {
  return byId('theme-toggle', HTMLButtonElement);
}

function themePopover(): HTMLElement {
  return byId('theme-popover');
}

function themeOption(pref: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`[data-testid="theme-option-${pref}"]`);
}

/** Open, as the surface says; it is in the page only from its first opening. */
function isOpen(): boolean {
  return document.getElementById('theme-popover')?.hasAttribute('data-open') === true;
}

/** The toggle, with a known stored theme and OS. */
async function renderToggle(
  stored: 'light' | 'dark' | 'system' | null,
  os: 'light' | 'dark',
): Promise<{ os: ReturnType<typeof stubColorScheme> }> {
  const scheme = stubColorScheme(os);
  if (stored !== null) {
    localStorage.setItem('dotli-theme', stored);
  }
  renderComponent(() => <ThemeToggle />);
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

async function openThemePopover(stored: 'light' | 'dark' | 'system', os: 'light' | 'dark'): Promise<HTMLButtonElement> {
  await renderToggle(stored, os);
  mouseClick(themeButton());
  await settle();
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
  it('As a dotli user, the theme button and popover keep their ids, roles and labels', async () => {
    // Given
    await renderToggle('dark', 'dark');
    const btn = themeButton();

    // Then
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-controls')).toBe('theme-popover');
    expect(
      ['sun', 'moon'].map(icon => document.querySelector(`[data-testid="theme-icon-${icon}"]`)?.parentElement),
    ).toEqual([btn, btn]);
    expect(btn.querySelector('[data-testid="theme-icon-system"]')).toBeNull();

    // When
    mouseClick(btn);
    await settle();

    // Then
    const popover = themePopover();
    expect(popover.getAttribute('role')).toBe('dialog');
    expect(popover.getAttribute('aria-label')).toBe('Appearance');
    expect(popover.getAttribute('tabindex')).toBe('-1');
    expect(query(popover, '[role="radiogroup"]').getAttribute('aria-label')).toBe('Theme');
    const options = Array.from(popover.querySelectorAll<HTMLButtonElement>('[data-testid^="theme-option-"]'));
    expect(options.map(o => o.dataset['testid'])).toEqual([
      'theme-option-light',
      'theme-option-dark',
      'theme-option-system',
    ]);
    expect(options.map(o => o.textContent)).toEqual(['Light', 'Dark', 'System']);
    expect(options.map(o => o.getAttribute('role'))).toEqual(['radio', 'radio', 'radio']);
    // Only the checked radio is in the Tab order.
    expect(options.map(o => o.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });

  it('As a dotli user, the theme button opens the popover with the current theme checked and focused', async () => {
    // Given
    await renderToggle('light', 'dark');
    const btn = themeButton();

    // When
    mouseClick(btn);
    await settle();

    // Then
    expect(themePopover().hasAttribute('data-open')).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(themeOption('light')?.getAttribute('aria-checked')).toBe('true');
    expect(themeOption('dark')?.getAttribute('aria-checked')).toBe('false');
    expect(themeOption('system')?.getAttribute('aria-checked')).toBe('false');
    expect(document.activeElement).toBe(themeOption('light'));
    expect(btn.title).toBe('Appearance: Light');
    expect(btn.getAttribute('aria-label')).toBe('Appearance: Light');
  });

  it('As a dotli user, I select Dark from the theme popover and it applies and persists, and the popover stays open', async () => {
    // Given
    const btn = await openThemePopover('light', 'light');
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
    expect(popover.hasAttribute('data-open')).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.title).toBe('Appearance: Dark');
    expect(btn.getAttribute('aria-label')).toBe('Appearance: Dark');
  });

  it('As a phone user, the Appearance popover opens as a bottom sheet with its title in the head, and picking a tile applies it and keeps the sheet open', async () => {
    // Given
    await renderToggle('dark', 'dark');
    stubPhoneViewport(true);

    // When
    mouseClick(themeButton());
    await settle();

    // Then
    const sheet = byId('theme-popover', HTMLDialogElement);
    expect(sheet.open).toBe(true);
    expect(byTestId('popover-sheet-title', sheet).textContent).toBe('Appearance');
    expect(query(sheet, '[role="radiogroup"]').getAttribute('aria-label')).toBe('Theme');
    // The first control in the content: the checked tile, the group's only Tab stop.
    expect(document.activeElement).toBe(themeOption('dark'));

    // When
    themeOption('light')?.click();
    await settle();

    // Then
    expect(sheet.open).toBe(true);
    expect(themeButton().getAttribute('aria-expanded')).toBe('true');
    expect(document.documentElement.getAttribute('data-theme-pref')).toBe('light');
  });

  it('As a dotli user, I select System from the theme popover and the theme resolves from the OS', async () => {
    // Given
    await openThemePopover('dark', 'light');

    // When
    themeOption('system')?.click();
    await settle();

    // Then
    expect(localStorage.getItem('dotli-theme')).toBe('system');
    expect(document.documentElement.getAttribute('data-theme-pref')).toBe('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(themeButton().title).toBe('Appearance: System');
  });

  it('moves the choice with the arrows, as a radio group', async () => {
    // Given
    await openThemePopover('dark', 'dark');
    const dark = query(document, '[data-testid="theme-option-dark"]');
    dark.focus();

    // When
    const right = await pressThemeKey('ArrowRight');

    // Then
    expect(right.defaultPrevented).toBe(true);
    expect(getThemeState().pref).toBe('system');
    expect(document.activeElement).toBe(themeOption('system'));

    // When: the arrows wrap at the ends of the row.
    await pressThemeKey('ArrowRight');

    // Then
    expect(getThemeState().pref).toBe('light');
    expect(document.activeElement).toBe(themeOption('light'));

    // When
    await pressThemeKey('ArrowUp');

    // Then
    expect(getThemeState().pref).toBe('system');
    expect(isOpen()).toBe(true);
  });

  it("As a mobile user, the More menu's Theme row opens the theme popover on the current theme", async () => {
    // Given: the bar has collapsed the theme button into the More menu.
    await renderCollapsedToggle('dark', 'dark');

    // When
    await tapMoreRow('theme');

    // Then
    expect(byId('more-popover').hasAttribute('data-open')).toBe(false);
    expect(isOpen()).toBe(true);
    expect(document.activeElement).toBe(themeOption('dark'));
  });

  it('As a mobile user, the theme popover I opened from the More menu hands focus back to the More button on Escape', async () => {
    // Given
    await renderCollapsedToggle('dark', 'dark');
    await tapMoreRow('theme');

    // When
    await pressThemeKey('Escape');

    // Then
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byId('more-button'));
  });

  it('As a dotli user whose browser blocks storage, picking a theme still applies it', async () => {
    // Given
    await openThemePopover('light', 'light');
    const blocked = (): never => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });

    // When
    themeOption('dark')?.click();
    await settle();

    // Then
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(themeButton().title).toBe('Appearance: Dark');
    expect(isOpen()).toBe(true);
  });

  it('As a mobile user, picking a theme while the bar has collapsed the theme button keeps the popover open, and Escape hands focus to the More button', async () => {
    // Given
    await renderCollapsedToggle('dark', 'dark');
    await tapMoreRow('theme');

    // When
    themeOption('light')?.click();
    await settle();

    // Then
    expect(localStorage.getItem('dotli-theme')).toBe('light');
    expect(isOpen()).toBe(true);

    // When
    await pressThemeKey('Escape');

    // Then
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(byId('more-button'));
  });

  it("As a dotli user, the System option's label follows the store after an OS change", async () => {
    // Given
    const { os } = await renderToggle(null, 'dark');
    mouseClick(themeButton());
    await settle();

    // When
    os.set('light');
    await settle();

    // Then
    expect(themeButton().title).toBe('Appearance: System');
    expect(themeOption('system')?.getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
