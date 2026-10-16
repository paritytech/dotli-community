// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach } from 'vitest';
import { showError, showErrorPage, showNoContentError, showRetryScreen } from '../src/ui.js';
import { byId, byTestId, query } from './support.js';

const XSS = '<img src=x onerror="alert(1)">';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('showErrorPage escaping', () => {
  // The detail carries the typed domain, so it is attacker-influenced and must never reach `innerHTML`.
  it('As a visitor, markup in an error message is shown to me as text', () => {
    showErrorPage({ title: 't', detail: XSS });
    expect(document.querySelector('img')).toBeNull();
    expect(byTestId('error-page-detail').textContent).toBe(XSS);
  });

  it('As a visitor, markup in the plain parts of a message is shown to me as text', () => {
    showErrorPage({ title: 't', detail: [XSS, ' tail'] });
    expect(document.querySelector('img')).toBeNull();
    expect(byTestId('error-page-detail').textContent).toBe(`${XSS} tail`);
  });

  it('As a visitor, markup in the bolded parts of a message is shown to me as text', () => {
    showErrorPage({ title: 't', detail: [{ strong: XSS }] });
    expect(document.querySelector('img')).toBeNull();
    const strong = query(byTestId('error-page-detail'), 'strong');
    expect(strong.textContent).toBe(XSS);
  });

  it('As a visitor, markup in the domain of a no-content error is shown to me as text', () => {
    showNoContentError(XSS);
    expect(document.querySelector('img')).toBeNull();
    expect(byTestId('error-page-domain').textContent.startsWith(XSS)).toBe(true);
  });

  it('As a visitor, markup in an error title is shown to me as text', () => {
    showErrorPage({ title: XSS });
    expect(document.querySelector('img')).toBeNull();
    expect(byTestId('error-page-title').textContent).toBe(XSS);
  });

  it('As a visitor, markup in a tip is shown to me as text', () => {
    showErrorPage({ title: 't', tips: [XSS] });
    byTestId('error-page-tips');
    expect(document.querySelector('img')).toBeNull();
    expect(query(document, '[data-testid="error-page-tips-list"] li').textContent).toBe(XSS);
  });

  it('As a visitor, markup in a button label is shown to me as text', () => {
    showErrorPage({
      title: 't',
      actions: [{ label: XSS, onClick: () => undefined }],
    });
    byTestId('error-page-actions');
    expect(document.querySelector('img')).toBeNull();
    expect(query(document, '#error-retry-btn [data-testid="error-page-retry-label"]').textContent).toBe(XSS);
  });
});

describe('showErrorPage primary action', () => {
  const noop = (): void => undefined;

  it('As a visitor, a lone button is the recommended one', () => {
    showErrorPage({ title: 't', actions: [{ label: 'A', onClick: noop }] });
    expect(query(document, '#error-retry-btn').hasAttribute('data-primary')).toBe(true);
  });

  it('As a visitor, the first button is recommended when none is marked', () => {
    showErrorPage({
      title: 't',
      actions: [
        { label: 'A', onClick: noop },
        { label: 'B', onClick: noop },
      ],
    });
    expect(query(document, '#error-retry-btn').hasAttribute('data-primary')).toBe(true);
    expect(query(document, '#error-retry-btn-1').hasAttribute('data-primary')).toBe(false);
  });

  // The gated failover screen puts `Go Back` second and primary, and its two-step confirmation depends on that.
  it('As a visitor, the button marked primary is the recommended one wherever it sits', () => {
    showErrorPage({
      title: 't',
      actions: [
        { label: 'A', onClick: noop },
        { label: 'B', primary: true, onClick: noop },
      ],
    });
    expect(query(document, '#error-retry-btn').hasAttribute('data-primary')).toBe(false);
    expect(query(document, '#error-retry-btn-1').hasAttribute('data-primary')).toBe(true);
  });

  // Reading, DOM and tab order must agree, so the primary is never placed with CSS `order`.
  it('As a keyboard user, I reach the buttons in the order I read them', () => {
    showErrorPage({
      title: 't',
      actions: [
        { label: 'Reload', primary: true, onClick: noop },
        { label: 'Open Settings', onClick: noop },
      ],
    });
    const labels = [...document.querySelectorAll('[data-testid="error-page-retry-label"]')].map(n => n.textContent);
    expect(labels).toEqual(['Open Settings', 'Reload']);
  });

  it('As a visitor, a lone button keeps its place', () => {
    showErrorPage({
      title: 't',
      actions: [{ label: 'Only', primary: true, onClick: noop }],
    });
    const labels = [...document.querySelectorAll('[data-testid="error-page-retry-label"]')].map(n => n.textContent);
    expect(labels).toEqual(['Only']);
  });

  // The primary is first in the array but rendered last, the only arrangement that catches an id keyed on render
  // position.
  it('As a test author, the first action keeps its id even when it renders last', () => {
    showErrorPage({
      title: 't',
      actions: [
        { label: 'Reload', primary: true, onClick: noop },
        { label: 'Open Settings', onClick: noop },
      ],
    });
    expect(query(document, '#error-retry-btn [data-testid="error-page-retry-label"]').textContent).toBe('Reload');
    expect(query(document, '#error-retry-btn-1 [data-testid="error-page-retry-label"]').textContent).toBe(
      'Open Settings',
    );
  });

  it('As a test author, the first action keeps its id whichever button is primary', () => {
    showErrorPage({
      title: 't',
      actions: [
        { label: 'First', onClick: noop },
        { label: 'Second', primary: true, onClick: noop },
      ],
    });
    expect(query(document, '#error-retry-btn [data-testid="error-page-retry-label"]').textContent).toBe('First');
  });
});

describe('showErrorPage optional blocks', () => {
  it('As a visitor, I see no empty Try list when there is nothing to suggest', () => {
    showErrorPage({ title: 't', tips: [] });
    byTestId('error-page');
    expect(document.querySelector('[data-testid="error-page-tips"]')).toBeNull();
  });

  it('As a visitor, I see no empty button row when there is nothing to click', () => {
    showErrorPage({ title: 't', actions: [] });
    byTestId('error-page');
    expect(document.querySelector('[data-testid="error-page-actions"]')).toBeNull();
  });

  it('As a visitor, clicking a button that opens a panel leaves the panel open', () => {
    let got: unknown = null;
    showErrorPage({
      title: 't',
      actions: [
        {
          label: 'A',
          onClick: event => {
            got = event;
          },
        },
      ],
    });
    query(document, '#error-retry-btn').click();
    expect(got).not.toBeNull();
    expect(typeof (got as MouseEvent).stopPropagation).toBe('function');
  });

  it('As a visitor, I see the warning mark only on a screen that warns me', () => {
    showErrorPage({ title: 't', glyph: 'warning' });
    expect(byTestId('error-page-glyph').hasAttribute('data-warning')).toBe(true);

    showErrorPage({ title: 't' });
    expect(byTestId('error-page-glyph').hasAttribute('data-warning')).toBe(false);
  });
});

describe('showErrorPage focus', () => {
  // The triggering button is gone, so unless focus moves a screen reader announces nothing.
  it('As a screen-reader user, the new screen is announced when it replaces the old one', () => {
    showErrorPage({ title: "Your connection won't be verified" });
    const title = byTestId('error-page-title');
    expect(document.activeElement).toBe(title);
  });

  it('As a keyboard user, the title does not take a tab stop', () => {
    showErrorPage({ title: 't' });
    expect(byTestId('error-page-title').getAttribute('tabindex')).toBe('-1');
  });
});

describe('showError shim', () => {
  it('As a visitor, tips passed to the shorthand still reach the page', () => {
    showError('t', 'd', undefined, ['Check the cable.']);
    byTestId('error-page-tips');
    expect(query(document, '[data-testid="error-page-tips-list"] li').textContent).toBe('Check the cable.');
  });

  it('As a visitor, a bare retry callback becomes a Retry button', () => {
    let clicked = false;
    showError('t', 'd', () => {
      clicked = true;
    });
    const btn = query(document, '#error-retry-btn');
    expect(btn.textContent).toContain('Retry');
    btn.click();
    expect(clicked).toBe(true);
  });
});

describe('showRetryScreen', () => {
  it('As a visitor whose load failed, retrying swaps the error page for the retry screen', () => {
    // Given
    showError('Failed to load content', 'd', () => undefined);

    // When
    showRetryScreen();

    // Then
    expect(document.querySelector('[data-testid="error-page"]')).toBeNull();
    byTestId('retry-screen');
    expect(byId('status').textContent).toBe('Retrying…');
  });
});
