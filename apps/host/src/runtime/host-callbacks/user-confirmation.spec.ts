// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { UserConfirmation } from '@parity/truapi-host';
import { afterEach, describe, expect, it } from 'vitest';
import { createBlockingModalCoordinator } from '../blocking-modal-queue.js';
import { createUserConfirmationAdapters as createAdapters } from './user-confirmation.js';
import type { ModalButton, ModalButtonVariant, ModalView } from '@dotli/ui';
import { SignIcon } from '../../components/icons/SignIcon.js';
import { createFakePrompts } from '../host-prompts.fake.js';

type UserConfirmationReview = Parameters<Required<UserConfirmation>['confirmUserAction']>[0];

let page = createFakePrompts();

/** The adapters with their dialogs shown through the page's fake prompts. */
function createUserConfirmationAdapters(label: string): ReturnType<typeof createAdapters> {
  return createAdapters(label, page.prompts, createBlockingModalCoordinator().createScope());
}

afterEach(() => {
  page = createFakePrompts();
});

/** The review on screen. */
function shownDialog(): ModalView<string> {
  return page.shownReview();
}

function modalShown(): Promise<unknown> {
  return page.promptShown();
}

function dismissModal(): void {
  page.dismiss();
}

function modalFields(): Record<string, string> {
  return Object.fromEntries(shownDialog().fields.map(field => [field.label, field.value]));
}

/** Every word the dialog shows. */
function modalText(): string {
  const view = shownDialog();
  return [view.title, ...view.fields.flatMap(f => [f.label, f.value]), ...view.buttons.map(b => b.label)].join(' ');
}

function footerVariants(): [string, ModalButtonVariant][] {
  return shownDialog().buttons.map(b => [b.label, b.variant]);
}

/** The shown dialog's main, lesser or rejecting button. */
function button(kind: 'sign' | 'secondary' | 'cancel'): ModalButton<string> {
  const variants: ModalButtonVariant[] =
    kind === 'sign' ? ['primary'] : kind === 'secondary' ? ['secondary'] : ['danger', 'cancel'];
  const found = shownDialog().buttons.find(b => variants.includes(b.variant));
  if (found === undefined) {
    throw new Error(`expected a ${kind} button`);
  }
  return found;
}

function press(kind: 'sign' | 'secondary' | 'cancel'): void {
  page.settleReview(button(kind).result);
}

describe('user confirmation modal', () => {
  it('As a dotli integrator, the host renders legacy payload signing as structured transaction fields', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    const review: UserConfirmationReview = {
      tag: 'SignPayload',
      value: {
        tag: 'LegacyAccount',
        value: {
          signer: '0x2afb6161ad5d4132b6d2362330e1475be90b706b0e68ba344a80e7a1df071304',
          payload: {
            blockHash: '0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2',
            blockNumber: '0x00000000',
            era: '0x00',
            genesisHash: '0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f',
            method: '0x0000',
            nonce: '0x00000000',
            signedExtensions: [],
            specVersion: '0x00000000',
            tip: '0x00000000000000000000000000000000',
            transactionVersion: '0x00000000',
            version: 4,
          },
        },
      },
    };

    // When
    const confirmation = confirmUserAction(review);
    await modalShown();

    // Then
    expect(shownDialog().title).toBe('Sign Transaction');
    expect(shownDialog().icon).toBe(SignIcon);
    expect(modalFields()).toEqual({
      App: 'localhost:3000',
      Signer: '0x2afb6161ad5d4132b6d2362330e1475be90b706b0e68ba344a80e7a1df071304',
      'Genesis Hash': '0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f',
      'Call Data': '0x0000',
      Version: '4',
    });
    expect(modalText()).not.toContain('Request');

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it('As a dotli integrator, the host renders product payload signing with the derived account', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    const review: UserConfirmationReview = {
      tag: 'SignPayload',
      value: {
        tag: 'Product',
        value: {
          request: {
            account: {
              dotNsIdentifier: 'truapi-playground.dot',
              derivationIndex: { tag: 'Index', value: 2 },
            },
            payload: {
              blockHash: '0xd6eec26135305a8ad257a20d003357284c8aa03d0bdb2b357ab0a22371e11ef2',
              blockNumber: '0x00000000',
              era: '0x00',
              genesisHash: '0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f',
              method: '0x0500',
              nonce: '0x00000000',
              signedExtensions: [],
              specVersion: '0x00000000',
              tip: '0x00000000000000000000000000000000',
              transactionVersion: '0x00000000',
              version: 4,
            },
          },
        },
      },
    };

    // When
    const confirmation = confirmUserAction(review);
    await modalShown();

    // Then
    expect(modalFields()).toEqual({
      App: 'localhost:3000',
      Signer: 'truapi-playground.dot / 2',
      'Genesis Hash': '0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f',
      'Call Data': '0x0500',
      Version: '4',
    });

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it('As a dotli integrator, the host renders legacy raw signing as structured sign-message fields', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    const review: UserConfirmationReview = {
      tag: 'SignRaw',
      value: {
        tag: 'LegacyAccount',
        value: {
          request: {
            signer: '0x2afb6161ad5d4132b6d2362330e1475be90b706b0e68ba344a80e7a1df071304',
            payload: {
              tag: 'Bytes',
              value: { bytes: '0x48656c6c6f2c20776f726c6421' },
            },
          },
          watermarked: true,
        },
      },
    };

    // When
    const confirmation = confirmUserAction(review);
    await modalShown();

    // Then
    expect(shownDialog().title).toBe('Sign Message');
    expect(shownDialog().icon).toBe(SignIcon);
    expect(modalFields()).toEqual({
      App: 'localhost:3000',
      Signer: '0x2afb6161ad5d4132b6d2362330e1475be90b706b0e68ba344a80e7a1df071304',
      Message: '0x48656c6c6f2c20776f726c6421',
    });
    expect(modalText()).not.toContain('Request');
    expect(shownDialog().fields.filter(f => f.warning === true)).toEqual([]);

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it('As a dotli integrator, the host warns before an unwatermarked raw signature', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    const review: UserConfirmationReview = {
      tag: 'SignRaw',
      value: {
        tag: 'Product',
        value: {
          request: {
            account: {
              dotNsIdentifier: 'truapi-playground.dot',
              derivationIndex: { tag: 'Index', value: 0 },
            },
            payload: { tag: 'Bytes', value: { bytes: '0x0304' } },
          },
          watermarked: false,
        },
      },
    };

    // When
    const confirmation = confirmUserAction(review);
    await modalShown();

    // Then
    expect(modalFields()).toEqual({
      App: 'localhost:3000',
      Signer: 'truapi-playground.dot / 0',
      Message: '0x0304',
      Warning: 'Unprotected signature: may authorize transactions',
    });
    expect(
      shownDialog()
        .fields.filter(f => f.warning === true)
        .map(f => f.label),
    ).toEqual(['Warning']);

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it("As a dotli integrator, the host names the product that signs with another product's account", async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    const review: UserConfirmationReview = {
      tag: 'SignRaw',
      value: {
        tag: 'Product',
        value: {
          callingProductId: 'truapi-playground.dot',
          request: {
            account: {
              dotNsIdentifier: 'other-product.dot',
              derivationIndex: { tag: 'Index', value: 1 },
            },
            payload: { tag: 'Bytes', value: { bytes: '0x0304' } },
          },
          watermarked: true,
        },
      },
    };

    // When
    const confirmation = confirmUserAction(review);
    await modalShown();

    // Then
    expect(modalFields()).toEqual({
      'Requesting product': 'truapi-playground.dot',
      App: 'localhost:3000',
      Signer: 'other-product.dot / 1',
      Message: '0x0304',
    });

    // When
    press('cancel');

    // Then
    await expect(confirmation).resolves.toBe(false);
  });

  it('As a dotli integrator, the host renders VRF signing as structured transcript fields', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    const review: UserConfirmationReview = {
      tag: 'SignVrf',
      value: {
        callingProductId: 'truapi-playground.dot',
        request: {
          account: {
            dotNsIdentifier: 'other-product.dot',
            derivationIndex: { tag: 'Index', value: 4 },
          },
          transcriptLabel: '0x706f703a61697264726f70',
          items: [
            { label: '0x646f6d61696e', value: '0x01' },
            { label: '0x7369676e6572', value: '0x02' },
          ],
        },
      },
    };

    // When
    const confirmation = confirmUserAction(review);
    await modalShown();

    // Then
    expect(shownDialog().title).toBe('Sign VRF Transcript');
    expect(modalFields()).toEqual({
      'Requesting product': 'truapi-playground.dot',
      Signer: 'other-product.dot / 4',
      'Transcript label': '0x706f703a61697264726f70',
      'Transcript items': '2',
    });

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it('As a dotli integrator, the host renders product transaction creation as structured fields', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    const review: UserConfirmationReview = {
      tag: 'CreateTransaction',
      value: {
        tag: 'Product',
        value: {
          payload: {
            signer: {
              dotNsIdentifier: 'truapi-playground.dot',
              derivationIndex: { tag: 'Index', value: 3 },
            },
            genesisHash: '0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f',
            callData: '0x0500',
            extensions: [],
            txExtVersion: 5,
            contacts: [],
          },
        },
      },
    };

    // When
    const confirmation = confirmUserAction(review);
    await modalShown();

    // Then
    expect(shownDialog().title).toBe('Sign Transaction');
    expect(modalFields()).toEqual({
      App: 'localhost:3000',
      Signer: 'truapi-playground.dot / 3',
      'Genesis Hash': '0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f',
      'Call Data': '0x0500',
      'Tx Ext Version': '5',
    });

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it('As a dotli integrator, the host renders resource allocation as structured resource fields', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    const review: UserConfirmationReview = {
      tag: 'ResourceAllocation',
      value: {
        callingProductId: 'localhost:3000',
        resources: [{ tag: 'StatementStoreAllowance' }, { tag: 'AutoSigning' }],
      },
    };

    // When
    const confirmation = confirmUserAction(review);
    await modalShown();

    // Then
    expect(shownDialog().title).toBe('Resource Allocation');
    expect(shownDialog().icon).toBeUndefined();
    const fields = modalFields();
    expect(fields).toEqual({
      'Requesting product': 'localhost:3000',
      Resources: 'StatementStoreAllowance, AutoSigning',
    });
    expect(Object.keys(fields)).not.toContain('Application');
    expect(Object.keys(fields)).not.toContain('Request');

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it('As a dotli integrator, the host renders account alias permission as structured product fields', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    const review: UserConfirmationReview = {
      tag: 'AccountAlias',
      value: {
        callingProductId: 'truapi-playground.dot',
        context: {
          productId: 'truapix-playground.dot',
          suffix: { tag: 'Index', value: 0 },
        },
        ringLocation: {
          chainId: '0x0000000000000000000000000000000000000000000000000000000000000000',
          junctions: [{ tag: 'PalletInstance', value: 42 }],
        },
      },
    };

    // When
    const confirmation = confirmUserAction(review);
    await modalShown();

    // Then
    expect(shownDialog().title).toBe('Alias Permission');
    expect(shownDialog().icon).toBeUndefined();
    const fields = modalFields();
    expect(fields).toEqual({
      'Requesting product': 'truapi-playground.dot',
      'Context product': 'truapix-playground.dot',
      'Context suffix': '0',
      Chain: '0x0000000000000000000000000000000000000000000000000000000000000000',
      'Ring path': 'PalletInstance(42)',
    });
    expect(button('cancel').label).toBe('Deny');
    expect(Object.keys(fields)).not.toContain('Application');
    expect(Object.keys(fields)).not.toContain('Request');

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it('As a dotli integrator, the host renders proof permission as structured ring fields', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    const review: UserConfirmationReview = {
      tag: 'CreateProof',
      value: {
        callingProductId: 'truapi-playground.dot',
        context: {
          productId: 'truapix-playground.dot',
          suffix: { tag: 'Index', value: 0 },
        },
        ringLocation: {
          chainId: '0x0000000000000000000000000000000000000000000000000000000000000000',
          junctions: [{ tag: 'PalletInstance', value: 42 }],
        },
        message: new Uint8Array([0x48, 0x69]),
      },
    };

    // When
    const confirmation = confirmUserAction(review);
    await modalShown();

    // Then
    expect(shownDialog().title).toBe('Proof Permission');
    expect(modalFields()).toEqual({
      'Requesting product': 'truapi-playground.dot',
      'Context product': 'truapix-playground.dot',
      'Context suffix': '0',
      Chain: '0x0000000000000000000000000000000000000000000000000000000000000000',
      'Ring path': 'PalletInstance(42)',
      Message: '0x4869',
    });

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it('As a dotli integrator, the host renders account access permission as structured product fields', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    const review: UserConfirmationReview = {
      tag: 'AccountAccess',
      value: {
        requestingProductId: 'truapi-playground.dot',
        targetProductId: 'other-product.dot',
      },
    };

    // When
    const confirmation = confirmUserAction(review);
    await modalShown();

    // Then
    expect(shownDialog().title).toBe('Account Access');
    const fields = modalFields();
    expect(fields).toEqual({
      'Requesting product': 'truapi-playground.dot',
      'Requested account': 'other-product.dot',
    });
    expect(button('cancel').label).toBe('Deny');
    expect(Object.keys(fields)).not.toContain('Application');
    expect(Object.keys(fields)).not.toContain('Request');

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it('As a dotli integrator, the host renders identity disclosure as structured product fields', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    const review: UserConfirmationReview = {
      tag: 'IdentityDisclosure',
      value: {
        productId: 'truapi-playground.dot',
      },
    };

    // When
    const confirmation = confirmUserAction(review);
    await modalShown();

    // Then
    expect(shownDialog().title).toBe('Identity Disclosure');
    const fields = modalFields();
    expect(fields).toEqual({
      'Requesting product': 'truapi-playground.dot',
    });
    expect(button('cancel').label).toBe('Deny');
    expect(Object.keys(fields)).not.toContain('Application');
    expect(Object.keys(fields)).not.toContain('Request');

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it('As a dotli integrator, the host renders product subtree resolution as structured product fields', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    const review: UserConfirmationReview = {
      tag: 'ProductSubtree',
      value: {
        productId: 'truapi-playground.dot',
      },
    };

    // When
    const confirmation = confirmUserAction(review);
    await modalShown();

    // Then
    expect(shownDialog().title).toBe('Product Account');
    expect(modalFields()).toEqual({
      'Requesting product': 'truapi-playground.dot',
    });
    // The answer is fixed for the pairing and cached, so the wording has to
    // read as granting access rather than as signing something.
    expect(button('sign').label).toBe('Allow');
    expect(button('cancel').label).toBe('Deny');

    // When
    press('cancel');

    // Then
    await expect(confirmation).resolves.toBe(false);
  });

  it('As a dotli integrator, the host rejects identity disclosure when the dialog is dismissed', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    const review: UserConfirmationReview = {
      tag: 'IdentityDisclosure',
      value: {
        productId: 'truapi-playground.dot',
      },
    };

    // When
    const confirmation = confirmUserAction(review);
    await modalShown();

    // When
    dismissModal();

    // Then
    await expect(confirmation).rejects.toThrow('User dismissed identity disclosure dialog');
  });

  it('As a dotli integrator, the host allows preimage submission from its dedicated dialog', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    // When
    const confirmation = confirmUserAction({
      tag: 'PreimageSubmit',
      value: { size: 2048n },
    });
    await modalShown();

    // Then
    expect(page.shown()).toEqual({ kind: 'preimage', size: 2048 });

    // When
    page.allowPreimage(true);

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it('As a dotli integrator, the host denies preimage submission when the user cancels', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    // When
    const confirmation = confirmUserAction({
      tag: 'PreimageSubmit',
      value: { size: 512n },
    });
    await modalShown();

    // When
    page.allowPreimage(false);

    // Then
    await expect(confirmation).resolves.toBe(false);
  });

  it('As a dotli user, an account access prompt highlights Allow once', async () => {
    // When
    void createUserConfirmationAdapters('localhost:3000').confirmPermission({
      tag: 'AccountAccess',
      value: {
        requestingProductId: 'truapi-playground.dot',
        targetProductId: 'other-product.dot',
      },
    });
    await modalShown();

    // Then
    expect(footerVariants()).toEqual([
      ['Deny', 'danger'],
      ['Always allow', 'secondary'],
      ['Allow once', 'primary'],
    ]);
  });

  it('As a dotli user, Allow once answers AllowOnce', async () => {
    // Given
    const decision = createUserConfirmationAdapters('localhost:3000').confirmPermission({
      tag: 'AccountAccess',
      value: {
        requestingProductId: 'truapi-playground.dot',
        targetProductId: 'other-product.dot',
      },
    });
    await modalShown();

    // When
    press('sign');

    // Then
    await expect(decision).resolves.toBe('AllowOnce');
  });

  it('As a dotli user, Always allow answers AllowAlways', async () => {
    // Given
    const decision = createUserConfirmationAdapters('localhost:3000').confirmPermission({
      tag: 'AccountAccess',
      value: {
        requestingProductId: 'truapi-playground.dot',
        targetProductId: 'other-product.dot',
      },
    });
    await modalShown();

    // When
    press('secondary');

    // Then
    await expect(decision).resolves.toBe('AllowAlways');
  });

  it('As a dotli user, Deny answers Deny', async () => {
    // Given
    const decision = createUserConfirmationAdapters('localhost:3000').confirmPermission({
      tag: 'AccountAccess',
      value: {
        requestingProductId: 'truapi-playground.dot',
        targetProductId: 'other-product.dot',
      },
    });
    await modalShown();

    // When
    press('cancel');

    // Then
    await expect(decision).resolves.toBe('Deny');
  });

  it('As a dotli user, allowing identity disclosure once is not remembered', async () => {
    // Given
    const decision = createUserConfirmationAdapters('localhost:3000').confirmPermission({
      tag: 'IdentityDisclosure',
      value: { productId: 'truapi-playground.dot' },
    });
    await modalShown();

    // When
    press('sign');

    // Then
    await expect(decision).resolves.toBe('AllowOnce');
  });

  it('As a dotli user, dismissing identity disclosure records no decision', async () => {
    // Given
    const decision = createUserConfirmationAdapters('localhost:3000').confirmPermission({
      tag: 'IdentityDisclosure',
      value: { productId: 'truapi-playground.dot' },
    });
    await modalShown();

    // When
    dismissModal();

    // Then
    await expect(decision).rejects.toThrow('User dismissed identity disclosure dialog');
  });

  it('As a dotli user, a per-action confirmation keeps two buttons', async () => {
    // When
    void createUserConfirmationAdapters('localhost:3000').confirmUserAction({
      tag: 'AccountAccess',
      value: {
        requestingProductId: 'truapi-playground.dot',
        targetProductId: 'other-product.dot',
      },
    });
    await modalShown();

    // Then
    expect(footerVariants().map(([label]) => label)).toEqual(['Deny', 'Allow']);
  });

  it('As a dotli user, Cancel on a signing prompt is drawn as the destructive answer', async () => {
    // Given
    const review: UserConfirmationReview = {
      tag: 'SignRaw',
      value: {
        tag: 'LegacyAccount',
        value: {
          request: {
            signer: '0x2afb6161ad5d4132b6d2362330e1475be90b706b0e68ba344a80e7a1df071304',
            payload: { tag: 'Bytes', value: { bytes: '0x48656c6c6f' } },
          },
          watermarked: true,
        },
      },
    };

    // When
    void createUserConfirmationAdapters('localhost:3000').confirmUserAction(review);
    await modalShown();

    // Then
    expect(footerVariants()).toEqual([
      ['Cancel', 'danger'],
      ['Sign', 'primary'],
    ]);
  });
});
