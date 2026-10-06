import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UrlPillShield } from '../src/components/shell/UrlPillShield.js';
import { setVerificationShieldState, showProductPill } from '../src/state/url-pill.js';
import { VERIFICATION_SHIELD_ID, VERIFICATION_TOOLTIP_ID } from '../src/verification-shield.js';
import { renderComponent, resetStores, settle, waitForContent } from './helpers/solid.js';
import { byId, byTestId } from './support.js';

function button(): HTMLButtonElement {
  return byId(VERIFICATION_SHIELD_ID, HTMLButtonElement);
}

function panel(): HTMLElement {
  return byId(VERIFICATION_TOOLTIP_ID);
}

function isOpen(): boolean {
  return (
    panel().id === 'verification-tooltip' &&
    panel().hasAttribute('data-open') &&
    button().getAttribute('aria-expanded') === 'true'
  );
}

function rowFor(state: string): HTMLElement {
  return byTestId(`verification-tooltip-row-${state}`, panel());
}

/**
 * Open the explainer as Enter or Space does (a click with `detail` 0; its
 * hover, focus and dismissal are the Tooltip stories'), and wait for its
 * body (its own chunk).
 */
async function openShield(): Promise<void> {
  button().dispatchEvent(new MouseEvent('click', { detail: 0, bubbles: true }));
  await settle();
  expect(isOpen()).toBe(true);
  await waitForContent(VERIFICATION_TOOLTIP_ID);
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
  vi.unstubAllGlobals();
  resetStores();
});

describe('verification shield', () => {
  it('As a screen-reader user, the shield is a real button described by the explainer, a tooltip', async () => {
    // Given
    const trigger = button();
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-describedby')).toBe(VERIFICATION_TOOLTIP_ID);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    // When
    await openShield();

    // Then
    expect(panel().getAttribute('role')).toBe('tooltip');
    expect(panel().getAttribute('popover')).toBe('manual');
    expect(panel().hasAttribute('tabindex')).toBe(false);
  });

  it('As a screen reader user, the state is in the button name, not only its colour', async () => {
    // Given: no state yet, as right after the pill appears, the explainer
    // open (its rows are its body).
    expect(button().getAttribute('aria-label')).toBe('How was this site loaded?');
    await openShield();
    expect(panel().querySelector('[data-selected]')).toBeNull();

    // When
    setVerificationShieldState('trusted');
    await settle();

    // Then
    expect(button().getAttribute('data-state')).toBe('trusted');
    expect(button().getAttribute('aria-label')).toBe('Loaded from a trusted provider. How was this site loaded?');
    expect(rowFor('trusted').hasAttribute('data-selected')).toBe(true);
    expect(rowFor('verified').hasAttribute('data-selected')).toBe(false);
    expect(rowFor('trusted').textContent).toContain('This site');
    expect(rowFor('verified').textContent).not.toContain('This site');

    // When
    setVerificationShieldState('verified');
    await settle();

    // Then
    expect(button().getAttribute('data-state')).toBe('verified');
    expect(button().getAttribute('aria-label')).toBe('Verified via light client. How was this site loaded?');
    expect(rowFor('verified').hasAttribute('data-selected')).toBe(true);
    expect(rowFor('trusted').hasAttribute('data-selected')).toBe(false);
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

  it('As a visitor, the explainer says how each way of loading a site works', async () => {
    // When
    await openShield();

    // Then
    expect(byTestId('verification-tooltip-title', panel()).textContent).toBe('How was this site loaded?');
    expect(rowFor('verified').textContent).toBe(
      'VerifiedChecked in your browser by the light client. The more secure option.',
    );
    expect(rowFor('trusted').textContent).toBe(
      'TrustedServed by an external RPC provider. Faster, but you rely on its answers.',
    );
  });

  it('As a low-vision user, each state ships its own glyph', async () => {
    // Given
    await openShield();

    // Then
    const glyphs = button().querySelectorAll('[data-testid="verification-shield-icon"]');
    expect(glyphs).toHaveLength(2);
    const [verified, trusted] = Array.from(glyphs).map(svg =>
      Array.from(svg.querySelectorAll('path'), path => path.getAttribute('d')).join(' '),
    );
    expect(verified).not.toBe(trusted);
    for (const state of ['verified', 'trusted']) {
      expect(rowFor(state).querySelector('[data-testid="verification-tooltip-icon"]')).not.toBeNull();
    }
  });
});
