import { cleanup } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UrlPillShield } from '../src/components/shell/UrlPillShield.js';
import { setVerificationShieldState, showProductPill } from '../src/state/url-pill.js';
import { VERIFICATION_SHIELD_ID, VERIFICATION_TOOLTIP_ID } from '../src/verification-shield.js';
import { renderComponent, resetStores, settle, waitForContent } from './helpers/solid.js';
import { byId, byTestId } from './support.js';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../../metrics/src/sentry.js', () => sentry);

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

function isClosed(): boolean {
  return !panel().hasAttribute('data-open') && button().getAttribute('aria-expanded') === 'false';
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
  await showShield();
  await waitForContent(VERIFICATION_TOOLTIP_ID);
}

/** Show the explainer as Enter or Space does, without waiting for its body. */
async function showShield(): Promise<void> {
  button().dispatchEvent(new MouseEvent('click', { detail: 0, bubbles: true }));
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
  vi.unstubAllGlobals();
  resetStores();
  sentry.captureException.mockClear();
  vi.doUnmock('../src/components/shell/VerificationContent.js');
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

  it('As a touch user, tapping into the app frame hides the explainer', async () => {
    // Given
    await openShield();

    // When: focus leaves the host window for the cross-origin iframe
    window.dispatchEvent(new Event('blur'));
    await settle();

    // Then
    expect(isClosed()).toBe(true);
  });

  it('As a dotli user, focus moving elsewhere (a modal coming up takes it) hides the explainer', async () => {
    // Given
    await openShield();

    // When
    byId('other-button').focus();
    await settle();

    // Then
    expect(isClosed()).toBe(true);
    expect(document.activeElement).toBe(byId('other-button'));
  });

  it('As a visitor after a deploy, an explainer that cannot load is reported once and hides; the next showing loads it again', async () => {
    // Given: a fresh page (the explainer's chunk not yet loaded) whose chunk
    // is gone, its import rejecting until `fail` is cleared
    cleanup();
    vi.resetModules();
    const chunk = { fail: true, imports: 0 };
    vi.doMock('../src/components/shell/VerificationContent.js', async (importOriginal: () => Promise<unknown>) => {
      chunk.imports += 1;
      if (chunk.fail) {
        throw new Error('chunk failed');
      }
      return importOriginal();
    });
    const pill = await import('../src/state/url-pill.js');
    const { UrlPillShield: FreshShield } = await import('../src/components/shell/UrlPillShield.js');
    pill.showProductPill('app', '.dot');
    renderComponent(FreshShield);
    await settle();

    // When
    await showShield();
    await vi.waitFor(() => {
      expect(sentry.captureException).toHaveBeenCalled();
    });
    await settle();

    // Then
    expect(isClosed()).toBe(true);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      flow: 'ui',
      step: 'root_render',
      tags: { root: 'tooltip:verification-tooltip' },
    });

    // When: the chunk is back
    chunk.fail = false;
    pill.setVerificationShieldState('verified');
    await openShield();

    // Then
    expect(chunk.imports).toBe(2);
    expect(rowFor('verified').textContent).toContain('Verified');
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('As a visitor, the explainer shows only how this site was loaded, and follows the state while open', async () => {
    // Given: no state yet, as right after the pill appears, the explainer open
    await openShield();
    expect(panel().querySelector('[data-testid^="verification-tooltip-row-"]')).toBeNull();

    // When
    setVerificationShieldState('trusted');
    await settle();

    // Then
    expect(button().getAttribute('data-state')).toBe('trusted');
    expect(rowFor('trusted').textContent).toBe(
      'TrustedServed by an external RPC provider. Faster, but you rely on its answers.',
    );
    expect(rowFor('trusted').querySelector('[data-testid="verification-tooltip-icon"]')).not.toBeNull();
    expect(panel().querySelector('[data-testid="verification-tooltip-row-verified"]')).toBeNull();

    // When
    setVerificationShieldState('verified');
    await settle();

    // Then
    expect(button().getAttribute('data-state')).toBe('verified');
    expect(rowFor('verified').textContent).toBe(
      'VerifiedChecked in your browser by the light client. The more secure option.',
    );
    expect(panel().querySelector('[data-testid="verification-tooltip-row-trusted"]')).toBeNull();
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
    const glyphs = button().querySelectorAll('[data-testid="verification-shield-icon"]');
    expect(glyphs).toHaveLength(2);
    const [verified, trusted] = Array.from(glyphs).map(svg =>
      Array.from(svg.querySelectorAll('path'), path => path.getAttribute('d')).join(' '),
    );
    expect(verified).not.toBe(trusted);
  });
});
