import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UrlPillShield } from '../src/components/shell/UrlPillShield.js';
import { showProductPill } from '../src/state/url-pill.js';
import { setBlockingModalActive } from '../src/state/topbar.js';
import {
  setVerificationShieldState,
  VERIFICATION_SHIELD_ID,
  VERIFICATION_TOOLTIP_ID,
} from '../src/verification-shield.js';
import { pointerPress, pointerPressUnfocusable, renderComponent, resetStores, settle, tabTo } from './helpers/solid.js';
import { byId, query } from './support.js';

function button(): HTMLButtonElement {
  return byId(VERIFICATION_SHIELD_ID, HTMLButtonElement);
}

function panel(): HTMLElement {
  return byId(VERIFICATION_TOOLTIP_ID);
}

// topbar-autohide.ts finds open surfaces by this id and the `.open` class.
function isOpen(): boolean {
  return (
    panel().id === 'verification-tooltip' &&
    panel().classList.contains('open') &&
    button().getAttribute('aria-expanded') === 'true'
  );
}

function isClosed(): boolean {
  return !panel().classList.contains('open') && button().getAttribute('aria-expanded') === 'false';
}

function rowFor(state: string): HTMLElement {
  return query(panel(), `.verification-tooltip-row[data-state="${state}"]`);
}

async function openShield(): Promise<void> {
  button().click();
  await settle();
  expect(isOpen()).toBe(true);
}

beforeEach(async () => {
  const other = document.createElement('button');
  other.id = 'other-button';
  other.textContent = 'Other';
  document.body.replaceChildren(other);
  showProductPill('app', '.dot');
  renderComponent(UrlPillShield);
  await settle();
});

afterEach(() => {
  resetStores();
});

describe('verification shield', () => {
  it('As a keyboard user, the shield is a real button that toggles the explainer', async () => {
    // Given
    const trigger = button();
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-controls')).toBe(VERIFICATION_TOOLTIP_ID);
    expect(isClosed()).toBe(true);

    // When: Enter and Space on a native button dispatch click
    trigger.click();
    await settle();

    // Then
    expect(isOpen()).toBe(true);

    // When
    trigger.click();
    await settle();

    // Then
    expect(isClosed()).toBe(true);
  });

  it('As a screen-reader user, the shield is a disclosure: it says whether the explainer is shown, and the explainer is plain text, not a dialog', async () => {
    // Given
    const trigger = button();

    // Then
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-controls')).toBe(VERIFICATION_TOOLTIP_ID);
    expect(trigger.hasAttribute('aria-haspopup')).toBe(false);
    expect(panel().hasAttribute('role')).toBe(false);
    expect(panel().hasAttribute('tabindex')).toBe(false);

    // When
    trigger.focus();
    await openShield();

    // Then: the explainer has nothing to focus, so focus stays on the shield.
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(trigger);
  });

  it('As a keyboard user, Tab away from the shield closes the explainer and focus moves on', async () => {
    // Given
    const next = document.createElement('button');
    next.id = 'next-button';
    document.body.append(next);
    button().focus();
    await openShield();

    // When
    const tab = tabTo(next);
    await settle();

    // Then
    expect(tab.defaultPrevented).toBe(false);
    expect(isClosed()).toBe(true);
    expect(document.activeElement).toBe(next);
  });

  it('As a mouse user, a press elsewhere closes the explainer without handing focus back to the shield', async () => {
    // Given
    button().focus();
    await openShield();

    // When: the press lands on nothing that takes focus.
    pointerPressUnfocusable(document.body);
    await settle();

    // Then
    expect(isClosed()).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });

  it('As a keyboard user, Escape closes the explainer and returns focus to the shield', async () => {
    // Given
    await openShield();
    button().blur();
    expect(document.activeElement).toBe(document.body);

    // When
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();

    // Then
    expect(isClosed()).toBe(true);
    expect(document.activeElement).toBe(button());
  });

  it('As a keyboard user, Escape leaves focus elsewhere in the bar where it is', async () => {
    // Given
    await openShield();
    const other = byId('other-button');
    other.focus();

    // When
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();

    // Then
    expect(isClosed()).toBe(true);
    expect(document.activeElement).toBe(other);
  });

  it('As a touch user, tapping elsewhere dismisses the explainer but tapping it keeps it up', async () => {
    // Given
    await openShield();

    // When: a tap lands on the panel copy
    panel()
      .querySelector('.verification-tooltip-title')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    // Then
    expect(isOpen()).toBe(true);

    // When: a tap lands outside the shield
    pointerPress(byId('other-button'));
    await settle();

    // Then
    expect(isClosed()).toBe(true);
  });

  it('As a touch user, tapping into the app frame dismisses the explainer', async () => {
    // Given
    await openShield();

    // When: focus leaves the host window for the cross-origin iframe
    window.dispatchEvent(new Event('blur'));
    await settle();

    // Then
    expect(isClosed()).toBe(true);
  });

  it('As a dotli integrator, a blocking modal closes the explainer', async () => {
    // Given
    await openShield();

    // When
    setBlockingModalActive(true);
    await settle();

    // Then
    expect(isClosed()).toBe(true);
  });

  it('As a screen reader user, the state is in the button name, not only its colour', async () => {
    // Given: no state yet, as right after the pill appears
    expect(button().getAttribute('aria-label')).toBe('How was this site loaded?');
    expect(panel().querySelector('.is-current')).toBeNull();

    // When
    setVerificationShieldState('trusted');
    await settle();

    // Then
    expect(button().classList.contains('trusted')).toBe(true);
    expect(button().classList.contains('verified')).toBe(false);
    expect(button().getAttribute('aria-label')).toBe('Loaded from a trusted provider. How was this site loaded?');
    expect(rowFor('trusted').classList.contains('is-current')).toBe(true);
    expect(rowFor('verified').classList.contains('is-current')).toBe(false);

    // When
    setVerificationShieldState('verified');
    await settle();

    // Then
    expect(button().classList.contains('verified')).toBe(true);
    expect(button().classList.contains('trusted')).toBe(false);
    expect(button().getAttribute('aria-label')).toBe('Verified via light client. How was this site loaded?');
    expect(rowFor('verified').classList.contains('is-current')).toBe(true);
    expect(rowFor('trusted').classList.contains('is-current')).toBe(false);
  });

  it('As a dotli user, a state change keeps an open explainer open', async () => {
    // Given
    await openShield();

    // When
    setVerificationShieldState('verified');
    await settle();

    // Then
    expect(isOpen()).toBe(true);
  });

  it('As a low-vision user, each state ships its own glyph', () => {
    // Then
    const glyphs = button().querySelectorAll('.verification-shield-icon');
    expect(glyphs).toHaveLength(2);
    const [verified, trusted] = Array.from(glyphs).map(svg => svg.querySelector('path')?.getAttribute('d') ?? '');
    expect(verified).not.toBe(trusted);
    for (const state of ['verified', 'trusted']) {
      expect(rowFor(state).querySelector(`.verification-tooltip-icon.is-${state}`)).not.toBeNull();
    }
  });
});
