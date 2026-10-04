// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { Button, ButtonLink } from '../../../src/components/primitives/Button.js';
import { mouseClick, renderComponent } from '../../helpers/solid.js';
import { byTestId } from '../../support.js';

describe('Button', () => {
  it('As a user, I press a button and its action runs once', () => {
    // Given
    const onClick = vi.fn();
    renderComponent(() => (
      <Button onClick={onClick} testId="save">
        Save
      </Button>
    ));
    const button = byTestId('save', document, HTMLButtonElement);

    // When
    mouseClick(button);

    // Then
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.type).toBe('button');
    expect(button.textContent).toBe('Save');
  });

  it('As a user, I see a disabled button that a form cannot submit through', () => {
    // Given / When
    renderComponent(() => (
      <Button disabled testId="apply" variant="primary">
        Save and apply
      </Button>
    ));

    // Then
    const button = byTestId('apply', document, HTMLButtonElement);
    expect(button.disabled).toBe(true);
    expect(button.type).toBe('button');
  });

  it('As an assistive technology user, I hear the label and the popup the button controls', () => {
    // Given / When
    renderComponent(() => (
      <Button
        aria-label="Account"
        aria-expanded="true"
        aria-controls="user-popover"
        aria-haspopup="dialog"
        testId="acct"
      >
        alice
      </Button>
    ));

    // Then
    const button = byTestId('acct');
    expect(button.getAttribute('aria-label')).toBe('Account');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe('user-popover');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('As a phone user, I follow a link drawn as a primary button to where it points', () => {
    // Given / When
    renderComponent(() => (
      <ButtonLink href="polkadotapp://pair?handshake=test" variant="primary" size="lg" block testId="open-app">
        Log in with Polkadot App
      </ButtonLink>
    ));

    // Then
    const link = byTestId('open-app', document, HTMLAnchorElement);
    expect(link.getAttribute('href')).toBe('polkadotapp://pair?handshake=test');
    expect(link.textContent).toBe('Log in with Polkadot App');
    expect(link.getAttribute('data-variant')).toBe('primary');
    expect(link.getAttribute('data-size')).toBe('lg');
    expect(link.getAttribute('data-block')).toBe('');
  });
});
