// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppearancePicker } from '../../../src/components/shell/Appearance.js';
import { getThemeState } from '../../../src/state/theme.js';
import { initTheme } from '../../../src/theme-controller.js';
import { renderComponent, resetStores, settle } from '../../helpers/solid.js';
import { stubColorScheme } from '../../helpers/color-scheme.js';
import { byTestId } from '../../support.js';

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

type Pref = 'light' | 'dark' | 'system';

function tile(pref: Pref): HTMLButtonElement {
  return byTestId(`theme-option-${pref}`, document, HTMLButtonElement);
}

function tiles(): HTMLButtonElement[] {
  return Array.from(byTestId('theme-options').querySelectorAll<HTMLButtonElement>('[role="radio"]'));
}

async function renderPicker(
  stored: Pref | null,
  os: 'light' | 'dark',
): Promise<{ os: ReturnType<typeof stubColorScheme> }> {
  const scheme = stubColorScheme(os);
  if (stored !== null) {
    localStorage.setItem('dotli-theme', stored);
  }
  renderComponent(() => <AppearancePicker />);
  await settle();
  initTheme();
  await settle();
  return { os: scheme };
}

async function pressKey(key: string): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(event);
  await settle();
  return event;
}

describe('AppearancePicker', () => {
  it('As a dotli user, I see the three theme tiles as a labelled radio group with the current theme checked', async () => {
    // When
    await renderPicker('dark', 'dark');

    // Then
    const group = byTestId('theme-options');
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(group.getAttribute('aria-label')).toBe('Theme');
    expect(tiles().map(o => o.dataset['testid'])).toEqual([
      'theme-option-light',
      'theme-option-dark',
      'theme-option-system',
    ]);
    expect(tiles().map(o => o.textContent)).toEqual(['Light', 'Dark', 'System']);
    expect(tiles().map(o => o.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(tiles().map(o => o.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });

  it('As a dotli user, I pick Dark and it applies at once and persists', async () => {
    // Given
    await renderPicker('light', 'light');

    // When
    tile('dark').click();
    await settle();

    // Then
    expect(localStorage.getItem('dotli-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme-pref')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(tile('dark').getAttribute('aria-checked')).toBe('true');
    expect(tile('light').getAttribute('aria-checked')).toBe('false');
    expect(tiles().map(o => o.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });

  it('As a dotli user, I pick System and the theme resolves from the OS', async () => {
    // Given
    await renderPicker('dark', 'light');

    // When
    tile('system').click();
    await settle();

    // Then
    expect(localStorage.getItem('dotli-theme')).toBe('system');
    expect(document.documentElement.getAttribute('data-theme-pref')).toBe('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(tile('system').getAttribute('aria-checked')).toBe('true');
  });

  it('As a keyboard user, I move the choice with the arrow keys and it wraps at the ends', async () => {
    // Given
    await renderPicker('dark', 'dark');
    tile('dark').focus();

    // When
    const right = await pressKey('ArrowRight');

    // Then
    expect(right.defaultPrevented).toBe(true);
    expect(getThemeState().pref).toBe('system');
    expect(document.activeElement).toBe(tile('system'));

    // When
    await pressKey('ArrowRight');

    // Then
    expect(getThemeState().pref).toBe('light');
    expect(document.activeElement).toBe(tile('light'));

    // When
    await pressKey('ArrowUp');

    // Then
    expect(getThemeState().pref).toBe('system');
    expect(document.activeElement).toBe(tile('system'));
    expect(localStorage.getItem('dotli-theme')).toBe('system');
  });

  it('As a dotli user whose browser blocks storage, I pick a theme and it still applies', async () => {
    // Given
    await renderPicker('light', 'light');
    const blocked = (): never => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });

    // When
    tile('dark').click();
    await settle();

    // Then
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(tile('dark').getAttribute('aria-checked')).toBe('true');
  });

  it('As a dotli user on System, I change the OS scheme and the theme follows while System stays checked', async () => {
    // Given
    const { os } = await renderPicker(null, 'dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    // When
    os.set('light');
    await settle();

    // Then
    expect(tile('system').getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
