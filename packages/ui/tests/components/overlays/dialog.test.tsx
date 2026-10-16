// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent } from '@solidjs/testing-library';
import { ModalOutlet } from '../../../src/components/overlays/ModalOutlet.js';
import { openModal, resetModalsForTests, type ModalView } from '../../../src/state/modals.js';
import { attachProductFrame, resetProductFrameLayout } from '../../../src/product-frame-layout.js';
import { renderComponent, settle } from '../../helpers/solid.js';
import { byTestId, query } from '../../support.js';
import { nth } from '../../helpers/nth.js';
import { stubPhoneViewport } from '../../helpers/viewport.js';
import { footerVariants } from '../../helpers/overlays.js';

type Choice = 'deny' | 'allow' | 'once' | 'dismissed';

function permissionLike(overrides: Partial<ModalView<Choice>> = {}): ModalView<Choice> {
  return {
    title: 'Permission Request',
    icon: '<svg data-testid="icon"></svg>',
    fields: [
      { label: 'Application', value: 'myapp.dot' },
      { label: 'Call Data', value: '0x1234', mono: true },
      { label: 'Warning', value: 'Careful', warning: true },
    ],
    notice: 'Granting this permission will reload the application.',
    buttons: [
      { label: 'Deny', variant: 'danger', result: 'deny' },
      { label: 'Always allow', variant: 'secondary', result: 'allow' },
      { label: 'Allow once', variant: 'primary', result: 'once' },
    ],
    dismissOnBackdrop: true,
    dismissResult: 'dismissed',
    fallbackResult: 'dismissed',
    ...overrides,
  };
}

function passwordView(error?: string): ModalView<'cancel' | 'unlock'> {
  return {
    title: 'Encrypted Content',
    fields: [],
    input: {
      kind: 'password',
      placeholder: 'Password',
      hint: 'Enter the password to decrypt.',
      ...(error === undefined ? {} : { error }),
    },
    buttons: [
      { label: 'Cancel', variant: 'cancel', result: 'cancel' },
      { label: 'Unlock', variant: 'primary', result: 'unlock' },
    ],
    dismissOnBackdrop: false,
    fallbackResult: 'cancel',
  };
}

function focused(): Element {
  return document.activeElement ?? document.body;
}

async function mountOutlet(): Promise<void> {
  renderComponent(() => <ModalOutlet />);
  await settle();
}

afterEach(() => {
  // Unmount first: the dialog is portalled into the body, which is emptied below.
  cleanup();
  vi.unstubAllGlobals();
  resetModalsForTests();
  resetProductFrameLayout();
  document.body.replaceChildren();
});

describe('signing dialog', () => {
  it('As a dotli user, a dialog shows its icon, fields, notice and buttons with dialog semantics', async () => {
    // Given
    void openModal(permissionLike());

    // When
    await mountOutlet();

    // Then: the frame is the modal dialog, named by the card's title.
    const frame = byTestId('signing-modal-backdrop');
    expect(frame.getAttribute('role')).toBe('dialog');
    expect(frame.getAttribute('aria-modal')).toBe('true');
    expect(frame.hasAttribute('data-open')).toBe(true);
    const modal = query(frame, ':scope > [data-testid="signing-modal"]');
    const title = query(modal, `#${frame.getAttribute('aria-labelledby') ?? ''}`);
    expect(title.tagName).toBe('H2');
    expect(title.textContent).toBe('Permission Request');
    expect(modal.querySelector('[data-testid="permission-modal-icon"] svg')).not.toBeNull();
    expect(
      [...document.querySelectorAll('[data-testid="signing-field"]')].map(f => f.hasAttribute('data-warning')),
    ).toEqual([false, false, true]);
    expect(
      query(document, '[data-testid="signing-field"][data-mono] [data-testid="signing-field-value"]').textContent,
    ).toBe('0x1234');
    expect(byTestId('permission-modal-notice').textContent).toBe(
      'Granting this permission will reload the application.',
    );
    expect(
      [...document.querySelectorAll('[data-testid="signing-modal-footer"] button')].map(b => [
        b.textContent,
        b.getAttribute('data-testid'),
      ]),
    ).toEqual([
      ['Deny', 'signing-btn-cancel'],
      ['Always allow', 'signing-btn-secondary'],
      ['Allow once', 'signing-btn-sign'],
    ]);
  });

  it('As a dotli user, the answer that rejects a request is drawn destructive, and Cancel on a password prompt is not', async () => {
    // Given
    void openModal(permissionLike());
    await mountOutlet();

    // Then
    expect(footerVariants()).toEqual([
      ['Deny', 'danger'],
      ['Always allow', 'secondary'],
      ['Allow once', 'primary'],
    ]);

    // When
    fireEvent.click(byTestId('signing-btn-cancel', document, HTMLButtonElement));
    void openModal(passwordView());
    await settle();

    // Then
    expect(footerVariants()).toEqual([
      ['Cancel', 'secondary'],
      ['Unlock', 'primary'],
    ]);
  });

  it("As a dotli user, clicking a button settles the dialog with that button's result and closes it", async () => {
    // Given
    const outcome = openModal(permissionLike());
    await mountOutlet();

    // When
    fireEvent.click(byTestId('signing-btn-secondary', document, HTMLButtonElement));
    await settle();

    // Then
    await expect(outcome).resolves.toEqual({ result: 'allow' });
    expect(document.querySelector('[data-testid="signing-modal-backdrop"]')).toBeNull();
  });

  it('As a phone user, the page under a prompt does not scroll, and scrolls again once it is answered', async () => {
    // Given
    stubPhoneViewport(true);
    const outcome = openModal(permissionLike());
    await mountOutlet();

    // Then
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(true);

    // When
    fireEvent.click(byTestId('signing-btn-secondary', document, HTMLButtonElement));
    await settle();

    // Then
    await expect(outcome).resolves.toEqual({ result: 'allow' });
    expect(document.body.hasAttribute('data-scroll-locked')).toBe(false);
  });

  it('As a dotli user, the backdrop and Escape dismiss a dialog that allows it, and a click inside does not', async () => {
    // Given
    const first = openModal(permissionLike());
    const second = openModal(permissionLike({ title: 'Second' }));
    await mountOutlet();

    // When
    fireEvent.click(byTestId('signing-modal', document));
    await settle();

    // Then
    expect(query(document, 'h2').textContent).toBe('Permission Request');

    // When
    fireEvent.click(byTestId('signing-modal-backdrop', document));
    await settle();

    // Then
    await expect(first).resolves.toEqual({ result: 'dismissed' });
    expect(query(document, 'h2').textContent).toBe('Second');

    // When
    fireEvent.keyDown(focused(), { key: 'Escape' });
    await settle();

    // Then
    await expect(second).resolves.toEqual({ result: 'dismissed' });
  });

  it("As a dotli user, Escape that dismisses a prompt reaches the page's other key listeners as handled", async () => {
    // Given
    void openModal(permissionLike());
    await mountOutlet();
    const modal = byTestId('signing-modal', document);
    const handled = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    document.addEventListener('keydown', handled);

    // When
    fireEvent.keyDown(modal, { key: 'Escape' });
    await settle();

    // Then
    expect(handled).toHaveReturnedWith(true);
    expect(document.querySelector('[data-testid="signing-modal-backdrop"]')).toBeNull();
    document.removeEventListener('keydown', handled);
  });

  it('As a dotli user, the backdrop and Escape do nothing on a dialog that must be answered', async () => {
    // Given
    let settled = false;
    void openModal(passwordView()).then(() => {
      settled = true;
    });
    await mountOutlet();

    // When
    fireEvent.click(byTestId('signing-modal-backdrop', document));
    fireEvent.keyDown(focused(), { key: 'Escape' });
    await settle();

    // Then
    expect(settled).toBe(false);
    expect(document.querySelector('[data-testid="signing-modal-backdrop"]')).not.toBeNull();
  });

  it("As a phone user, a prompt's sheet is headed by its title, and its close button dismisses it as the scrim does", async () => {
    // Given
    stubPhoneViewport(true);
    const outcome = openModal(permissionLike());
    await mountOutlet();

    // Then: the head leads the sheet.
    const modal = byTestId('signing-modal', document);
    const head = byTestId('signing-modal-sheet-head', modal);
    expect(modal.firstElementChild).toBe(head);
    expect(byTestId('signing-modal-sheet-title', head).textContent).toBe('Permission Request');
    const close = byTestId('signing-modal-sheet-close', head, HTMLButtonElement);
    expect(close.getAttribute('aria-label')).toBe('Close');

    // When
    fireEvent.click(close);
    await settle();

    // Then
    await expect(outcome).resolves.toEqual({ result: 'dismissed' });
    expect(document.querySelector('[data-testid="signing-modal-backdrop"]')).toBeNull();
  });

  it('As a phone user, the close button on a prompt that must be answered answers it with its Cancel, without what I typed', async () => {
    // Given
    stubPhoneViewport(true);
    const outcome = openModal(passwordView());
    await mountOutlet();
    fireEvent.input(byTestId('password-prompt-input', document, HTMLInputElement), {
      target: { value: 'typed' },
    });
    await settle();

    // When
    fireEvent.click(byTestId('signing-modal-sheet-close', document, HTMLButtonElement));
    await settle();

    // Then
    await expect(outcome).resolves.toEqual({ result: 'cancel' });
  });

  it('As a phone user, the close button on a prompt with no Cancel and no scrim answer answers it with its danger reject', async () => {
    // Given
    stubPhoneViewport(true);
    const outcome = openModal(permissionLike({ dismissOnBackdrop: false }));
    await mountOutlet();

    // When
    fireEvent.click(byTestId('signing-modal-sheet-close', document, HTMLButtonElement));
    await settle();

    // Then
    await expect(outcome).resolves.toEqual({ result: 'deny' });
  });

  it('As a phone user, the close button on a scrim-dismissable prompt with no scrim answer answers it with its danger reject', async () => {
    // Given
    stubPhoneViewport(true);
    const { dismissResult: _unused, ...view } = permissionLike();
    const outcome = openModal(view);
    await mountOutlet();

    // When
    fireEvent.click(byTestId('signing-modal-sheet-close', document, HTMLButtonElement));
    await settle();

    // Then
    await expect(outcome).resolves.toEqual({ result: 'deny' });
  });

  it('As a dotli user, focus starts on the dialog, not on the approve button, and Tab stays inside', async () => {
    // Given
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    void openModal(permissionLike());

    // When
    await mountOutlet();

    // Then
    const modal = byTestId('signing-modal', document);
    expect(document.activeElement).toBe(modal);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="signing-modal-footer"] button')];

    // When
    nth(buttons, 2).focus();
    fireEvent.keyDown(focused(), { key: 'Tab' });

    // Then
    expect(document.activeElement).toBe(buttons[0]);

    // When
    fireEvent.keyDown(focused(), { key: 'Tab', shiftKey: true });

    // Then
    expect(document.activeElement).toBe(buttons[2]);
  });

  it('As a dotli user, focus goes back to where it was when the dialog closes', async () => {
    // Given
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    void openModal(permissionLike());
    await mountOutlet();

    // When
    fireEvent.click(byTestId('signing-btn-cancel', document, HTMLButtonElement));
    await settle();

    // Then
    expect(document.activeElement).toBe(opener);
  });

  it('As a dotli user, the password field gets focus, Unlock waits for input, and Enter submits it', async () => {
    // Given
    const outcome = openModal(passwordView('Wrong password'));
    await mountOutlet();
    const input = byTestId('password-prompt-input', document, HTMLInputElement);
    const unlock = byTestId('signing-btn-sign', document, HTMLButtonElement);

    // Then
    expect(document.activeElement).toBe(input);
    expect(input.type).toBe('password');
    expect(input.placeholder).toBe('Password');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(byTestId('password-prompt-error').textContent).toBe('Wrong password');
    expect(unlock.disabled).toBe(true);

    // When
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle();

    // Then
    expect(document.querySelector('[data-testid="signing-modal-backdrop"]')).not.toBeNull();

    // When
    fireEvent.input(input, { target: { value: 'hunter2' } });
    await settle();

    // Then
    expect(unlock.disabled).toBe(false);

    // When
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle();

    // Then
    await expect(outcome).resolves.toEqual({
      result: 'unlock',
      value: 'hunter2',
    });
  });

  it('As a dotli user, Cancel on the password dialog settles without the typed value', async () => {
    // Given
    const outcome = openModal(passwordView());
    await mountOutlet();
    fireEvent.input(byTestId('password-prompt-input', document, HTMLInputElement), {
      target: { value: 'typed' },
    });
    await settle();

    // When
    fireEvent.click(byTestId('signing-btn-cancel', document, HTMLButtonElement));
    await settle();

    // Then
    await expect(outcome).resolves.toEqual({ result: 'cancel' });
  });

  it('As a dotli user, the next queued dialog gets focus after the first one closes', async () => {
    // Given
    void openModal(permissionLike());
    void openModal(permissionLike({ title: 'Second' }));
    await mountOutlet();

    // When
    fireEvent.click(byTestId('signing-btn-cancel', document, HTMLButtonElement));
    await settle();

    // Then
    expect(query(document, 'h2').textContent).toBe('Second');
    expect(document.activeElement).toBe(document.querySelector('[data-testid="signing-modal"]'));
  });

  it('As a keyboard user, focus goes back to where it was after two queued dialogs close', async () => {
    // Given: a permission prompt, then a signing prompt, opened from a button.
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    void openModal(permissionLike());
    void openModal(permissionLike({ title: 'Second' }));
    await mountOutlet();

    // When: both are answered.
    fireEvent.click(byTestId('signing-btn-cancel', document, HTMLButtonElement));
    await settle();
    fireEvent.click(byTestId('signing-btn-cancel', document, HTMLButtonElement));
    await settle();

    // Then
    expect(document.querySelector('[data-testid="signing-modal"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('As a keyboard user, when the element I came from is gone, focus goes to the app, not the page', async () => {
    // Given: the app frame, and a button that goes away while the dialog is up.
    const app = document.createElement('div');
    app.id = 'app';
    const frame = document.createElement('iframe');
    app.appendChild(frame);
    attachProductFrame(frame);
    const opener = document.createElement('button');
    document.body.append(app, opener);
    opener.focus();
    void openModal(permissionLike());
    await mountOutlet();
    opener.remove();

    // When
    fireEvent.click(byTestId('signing-btn-cancel', document, HTMLButtonElement));
    await settle();

    // Then
    expect(document.activeElement).toBe(frame);
  });

  it("As a keyboard user during an app reload, focus goes to the app's new frame, not the outgoing one", async () => {
    // Given: the outgoing frame still in the page ahead of the new one.
    const app = document.createElement('div');
    app.id = 'app';
    const outgoing = document.createElement('iframe');
    const incoming = document.createElement('iframe');
    app.append(outgoing, incoming);
    attachProductFrame(outgoing);
    attachProductFrame(incoming);
    const opener = document.createElement('button');
    document.body.append(app, opener);
    opener.focus();
    void openModal(permissionLike());
    await mountOutlet();
    opener.remove();

    // When
    fireEvent.click(byTestId('signing-btn-cancel', document, HTMLButtonElement));
    await settle();

    // Then
    expect(document.activeElement).toBe(incoming);
  });

  it('As a dotli user answering two queued prompts, the second opens over the scrim that is already up', async () => {
    // Given
    void openModal(permissionLike());
    void openModal(permissionLike({ title: 'Second' }));
    await mountOutlet();

    // Then: the first prompt brings its scrim in.
    expect(byTestId('signing-modal-backdrop', document).hasAttribute('data-follows')).toBe(false);

    // When
    fireEvent.click(byTestId('signing-btn-cancel', document, HTMLButtonElement));
    await settle();

    // Then
    expect(query(document, 'h2').textContent).toBe('Second');
    expect(byTestId('signing-modal-backdrop', document).hasAttribute('data-follows')).toBe(true);
  });

  it('As a dotli user denying a prompt with a scrim press, the queued one still opens over the same scrim', async () => {
    // Given
    void openModal(permissionLike());
    void openModal(permissionLike({ title: 'Second' }));
    await mountOutlet();
    // A real press outside the card moves focus to the body first.
    (document.activeElement as HTMLElement | null)?.blur();

    // When
    fireEvent.click(byTestId('signing-modal-backdrop', document));
    await settle();

    // Then
    expect(query(document, 'h2').textContent).toBe('Second');
    expect(byTestId('signing-modal-backdrop', document).hasAttribute('data-follows')).toBe(true);
  });

  it('As a dotli user, a scrim press that hands over to a queued dialog still returns focus to where I was when the queue ends', async () => {
    // Given: two queued prompts opened from a focused button.
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    void openModal(permissionLike());
    void openModal(permissionLike({ title: 'Second' }));
    await mountOutlet();
    // A real press outside the card moves focus to the body first.
    (document.activeElement as HTMLElement | null)?.blur();

    // When: the scrim press dismisses the first, then the second is answered.
    fireEvent.click(byTestId('signing-modal-backdrop', document));
    await settle();
    fireEvent.click(byTestId('signing-btn-cancel', document, HTMLButtonElement));
    await settle();

    // Then
    expect(document.querySelector('[data-testid="signing-modal"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('As a dotli user, a prompt that opens after the queue emptied brings its own scrim in', async () => {
    // Given
    void openModal(permissionLike());
    await mountOutlet();
    fireEvent.click(byTestId('signing-btn-cancel', document, HTMLButtonElement));
    await settle();
    expect(document.querySelector('[data-testid="signing-modal-backdrop"]')).toBeNull();

    // When
    void openModal(permissionLike({ title: 'Later' }));
    await settle();

    // Then
    expect(query(document, 'h2').textContent).toBe('Later');
    expect(byTestId('signing-modal-backdrop', document).hasAttribute('data-follows')).toBe(false);
  });
});
