// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { UserConfirmation } from '@parity/truapi-host';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry, recordCaptures, type RecordingSentry } from '@dotli/metrics/testing';
import { spans as S } from '@dotli/metrics';
import { withActiveTld } from '@dotli/config';
import { createBlockingModalCoordinator, type BlockingModalCoordinator } from '../blocking-modal-queue.js';
import type { HostPrompts } from '../host-prompts.js';
import { requestFrame, responseFrame } from '../phone-requests.fake.js';
import { createPhoneRequestTracker, type PhoneRequestTracker } from '../phone-requests.js';
import { createUserConfirmationAdapters as createAdapters } from './user-confirmation.js';
import type { ModalButton, ModalButtonVariant, ModalView } from '@dotli/ui';
import { SignIcon } from '../../components/icons/SignIcon.js';
import { createFakePrompts } from '../host-prompts.fake.js';
import { recordLog, resetAllStoresForTests } from '@dotli/shared/testing';

type UserConfirmationReview = Parameters<Required<UserConfirmation>['confirmUserAction']>[0];

let page = createFakePrompts();

/** The adapters with their dialogs shown through the page's fake prompts, with no request on the way to a phone. */
function createUserConfirmationAdapters(
  label: string,
  phoneRequests: PhoneRequestTracker = createPhoneRequestTracker(),
): ReturnType<typeof createAdapters> {
  return createAdapters(label, page.prompts, createBlockingModalCoordinator().createScope(), phoneRequests);
}

afterEach(() => {
  resetAllStoresForTests();
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
    expect(page.shown()).toEqual({ kind: 'preimage', label: 'localhost:3000', size: 2048 });

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

  it('As a dotli user, dismissing an account access prompt records no decision', async () => {
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
    dismissModal();

    // Then
    await expect(decision).rejects.toThrow('User dismissed permission dialog');
  });

  it('As a dotli user, cancelling a preimage permission records no denial', async () => {
    // Given
    const decision = createUserConfirmationAdapters('localhost:3000').confirmPermission({
      tag: 'PreimageSubmit',
      value: { size: 512n },
    });
    await modalShown();

    // When
    page.allowPreimage(false);

    // Then
    await expect(decision).rejects.toThrow('User cancelled preimage submission');
  });

  it('As a dotli user, allowing a preimage permission is not remembered', async () => {
    // Given
    const decision = createUserConfirmationAdapters('localhost:3000').confirmPermission({
      tag: 'PreimageSubmit',
      value: { size: 512n },
    });
    await modalShown();

    // When
    page.allowPreimage(true);

    // Then
    await expect(decision).resolves.toBe('AllowOnce');
  });

  it('As a dotli user, Escape on a one-off review answers no and throws nothing', async () => {
    // Given
    const confirmation = createUserConfirmationAdapters('localhost:3000').confirmUserAction({
      tag: 'AccountAccess',
      value: {
        requestingProductId: 'truapi-playground.dot',
        targetProductId: 'other-product.dot',
      },
    });
    await modalShown();

    // When
    dismissModal();

    // Then
    await expect(confirmation).resolves.toBe(false);
  });
});

const productAccount = { dotNsIdentifier: 'product.dot', derivationIndex: { tag: 'Index' as const, value: 0 } };

function signRequest(nonce: `0x${string}`) {
  return {
    account: productAccount,
    payload: {
      blockHash: '0x01' as const,
      blockNumber: '0x02' as const,
      era: '0x03' as const,
      genesisHash: '0x04' as const,
      method: '0x05' as const,
      nonce,
      specVersion: '0x07' as const,
      tip: '0x08' as const,
      transactionVersion: '0x09' as const,
      signedExtensions: [],
      version: 4,
    },
  };
}

function signReview(nonce: `0x${string}`): UserConfirmationReview {
  return {
    tag: 'SignPayload',
    value: { tag: 'Product', value: { callingProductId: 'product.dot', request: signRequest(nonce) } },
  };
}

const SIGNED = { ok: { signature: '0x01' } };
const REJECTED = { domain: { tag: 'Rejected' } };

/** A paired phone's adapters, whose product frame relays through `tap`. */
function pairedPhone({
  prompts = page.prompts,
  coordinator = createBlockingModalCoordinator(),
  tracker = createPhoneRequestTracker({
    reportUndecodable: (method, error) => {
      throw new Error(`${method} frame did not decode`, { cause: error });
    },
  }),
}: { prompts?: HostPrompts; coordinator?: BlockingModalCoordinator; tracker?: PhoneRequestTracker } = {}) {
  const tap = tracker.connect();
  const scope = coordinator.createScope();
  const adapters = createAdapters('localhost:3000', prompts, scope, tracker);
  return { tracker, tap, scope, ...adapters };
}

/** A paired phone whose sign request the user signed in the dialog, so the review goes to the phone. */
async function signedForPhone(options?: Parameters<typeof pairedPhone>[0]) {
  const phone = pairedPhone(options);
  phone.tap.fromProduct(requestFrame('a', 'signPayload', signRequest('0x06')));
  const confirmation = phone.confirmUserAction(signReview('0x06'));
  await modalShown();
  press('sign');
  return { ...phone, confirmation };
}

/** Resolves on the next metric recorded, so a spec waits on the count rather than polling. */
function nextRecord(): { sentry: RecordingSentry; recorded: Promise<void> } {
  let record = (): void => undefined;
  const recorded = new Promise<void>(resolve => {
    record = resolve;
  });
  return { sentry: bindRecordingSentry({ onFinished: onTestFinished, onRecord: record }), recorded };
}

/** Whether the dialog on screen is the waiting step. */
function waiting(): boolean {
  return page.shownReview().buttons[0]?.label === 'Wait in background';
}

describe('waiting on the phone', () => {
  it('As a product, my approval reaches the core while the dialog waits on the phone', async () => {
    // Given
    const { tap, confirmUserAction } = pairedPhone();
    tap.fromProduct(requestFrame('a', 'signPayload', signRequest('0x06')));
    const confirmation = confirmUserAction(signReview('0x06'));
    await modalShown();

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
    expect(waiting()).toBe(true);
    expect(shownDialog().title).toBe('Sign Transaction');
    expect(shownDialog().icon).toBe(SignIcon);
  });

  it('As a user, the waiting step closes when the phone signs and I see it signed', async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { tap, confirmation } = await signedForPhone();
    await confirmation;

    // When
    tap.fromCore(responseFrame('a', 'signPayload', SIGNED));

    // Then
    const notices = await page.noticesShown(1);
    expect(page.pending()).toEqual([]);
    expect(notices.map(n => n.text)).toEqual(['Sign Transaction: signed in Polkadot App']);
    expect(notices[0]?.label).toBe(withActiveTld('localhost:3000'));
    expect(sentry.counted(S.PHONE_REQUEST)).toEqual([{ outcome: 'ok', reason: 'signPayload', background: 'no' }]);
  });

  it('As a user, I wait in background and still hear the outcome', async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { tap, confirmation } = await signedForPhone();
    await confirmation;

    // When
    page.settleReview('background');

    // Then
    expect(page.pending()).toEqual([]);

    // When
    tap.fromCore(responseFrame('a', 'signPayload', REJECTED));

    // Then
    const notices = await page.noticesShown(1);
    expect(page.pending()).toEqual([]);
    expect(notices.map(n => n.text)).toEqual(['Rejected in Polkadot App']);
    expect(sentry.counted(S.PHONE_REQUEST)).toEqual([{ outcome: 'refused', reason: 'signPayload', background: 'yes' }]);
  });

  it('As a user, I press Escape on the waiting step and it goes to the background, rejecting nothing', async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { tap, confirmation } = await signedForPhone();

    // When
    dismissModal();

    // Then
    await expect(confirmation).resolves.toBe(true);
    expect(page.pending()).toEqual([]);
    expect(page.notices).toEqual([]);

    // When
    tap.fromCore(responseFrame('a', 'signPayload', SIGNED));

    // Then
    const notices = await page.noticesShown(1);
    expect(notices.map(n => n.text)).toEqual(['Sign Transaction: signed in Polkadot App']);
    expect(sentry.counted(S.PHONE_REQUEST)).toEqual([{ outcome: 'ok', reason: 'signPayload', background: 'yes' }]);
  });

  it('As a user, the next prompt shows once I send the wait to the background', async () => {
    // Given
    const { tap, confirmUserAction } = pairedPhone();
    tap.fromProduct(requestFrame('a', 'signPayload', signRequest('0x06')));
    tap.fromProduct(requestFrame('b', 'signPayload', signRequest('0x07')));
    const first = confirmUserAction(signReview('0x06'));
    const second = confirmUserAction(signReview('0x07'));
    await modalShown();

    // When
    press('sign');

    // Then
    await expect(first).resolves.toBe(true);
    expect(page.pending()).toHaveLength(1);
    expect(waiting()).toBe(true);

    // When
    page.settleReview('background');

    // Then
    await page.promptShown(prompt => prompt.kind === 'review' && prompt.dialog.buttons[0]?.label === 'Cancel');
    expect(page.pending()).toHaveLength(1);

    // When
    press('sign');

    // Then
    await expect(second).resolves.toBe(true);
    expect(waiting()).toBe(true);
  });

  it('As a user, a torn down host closes the waiting step, frees the prompt slot and still counts the request once', async () => {
    // Given
    const coordinator = createBlockingModalCoordinator();
    const { tracker, scope, confirmation } = await signedForPhone({ coordinator });
    await expect(confirmation).resolves.toBe(true);
    const next = createAdapters(
      'localhost:3000',
      page.prompts,
      coordinator.createScope(),
      createPhoneRequestTracker(),
    ).confirmUserAction(signReview('0x07'));

    // When
    scope.dispose();

    // Then
    await page.promptShown(prompt => prompt.kind === 'review' && prompt.dialog.buttons[0]?.label === 'Cancel');
    expect(page.pending()).toHaveLength(1);
    press('sign');
    await expect(next).resolves.toBe(true);

    // When
    const { sentry, recorded } = nextRecord();
    tracker.dispose();
    await recorded;

    // Then
    expect(sentry.counted(S.PHONE_REQUEST)).toEqual([{ outcome: 'gone', reason: 'signPayload', background: 'no' }]);
    expect(page.notices).toEqual([]);
  });

  it('As a user, a toast that fails to show is reported and the request is still counted', async () => {
    // Given
    const errors: unknown[] = [];
    const captured = recordCaptures({ onFinished: onTestFinished, errors });
    const { sentry, recorded } = nextRecord();
    const { tap, confirmation } = await signedForPhone({
      prompts: {
        ...page.prompts,
        notify: () => {
          throw new Error('toast stack gone');
        },
      },
    });
    await expect(confirmation).resolves.toBe(true);

    // When
    tap.fromCore(responseFrame('a', 'signPayload', SIGNED));
    await recorded;

    // Then
    expect(sentry.counted(S.PHONE_REQUEST)).toEqual([{ outcome: 'ok', reason: 'signPayload', background: 'no' }]);
    await page.screenCleared();
    expect(captured.map(c => c.step)).toEqual(['phone_request_notice']);
    expect(errors).toEqual([new Error('toast stack gone')]);
  });

  it('As a user, an answer that does not decode ends the wait, is reported and is counted once as undecodable', async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const captured = recordCaptures({ onFinished: onTestFinished });
    recordLog({ onFinished: onTestFinished });
    const { tap, confirmation } = await signedForPhone({ tracker: createPhoneRequestTracker() });
    await expect(confirmation).resolves.toBe(true);
    const answer = responseFrame('a', 'signPayload', SIGNED);

    // When
    tap.fromCore(answer.subarray(0, answer.length - 3));

    // Then
    const notices = await page.noticesShown(1);
    expect(page.pending()).toEqual([]);
    expect(notices.map(n => n.text)).toEqual(["Polkadot App didn't complete the request: undecodable"]);
    expect(captured.map(c => c.step)).toEqual(['phone_request']);
    expect(sentry.counted(S.PHONE_REQUEST)).toEqual([
      { outcome: 'undecodable', reason: 'signPayload', background: 'no' },
    ]);
  });

  it('As a user, a review whose phone lookup throws closes as today and answers the core', async () => {
    // Given
    recordCaptures({ onFinished: onTestFinished });
    recordLog({ onFinished: onTestFinished });
    const tracker = createPhoneRequestTracker();
    const { confirmUserAction } = pairedPhone({
      tracker: {
        ...tracker,
        claim: () => {
          throw new Error('tracker broken');
        },
      },
    });
    const confirmation = confirmUserAction(signReview('0x06'));
    await modalShown();

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
    expect(page.pending()).toEqual([]);
  });

  it('As a user, a phone answer already in as the step opens closes it at once with one toast', async () => {
    // Given
    const { tap, confirmation } = await signedForPhone();

    // When
    tap.fromCore(responseFrame('a', 'signPayload', SIGNED));

    // Then
    await expect(confirmation).resolves.toBe(true);
    await page.screenCleared();
    const notices = await page.noticesShown(1);
    expect(notices.map(n => n.text)).toEqual(['Sign Transaction: signed in Polkadot App']);
  });

  it('As a user, a torn down connection closes the waiting step without a toast', async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { tracker, confirmation } = await signedForPhone();
    await confirmation;

    // When
    tracker.dispose();

    // Then
    await page.screenCleared();
    expect(page.notices).toEqual([]);
    expect(sentry.counted(S.PHONE_REQUEST)).toEqual([{ outcome: 'gone', reason: 'signPayload', background: 'no' }]);
  });

  it('As a local wallet, signing closes the dialog as today', async () => {
    // Given a local wallet core, whose tracker is disposed as it has no phone
    const tracker = createPhoneRequestTracker();
    tracker.dispose();
    tracker.connect().fromProduct(requestFrame('a', 'signPayload', signRequest('0x06')));
    const confirmation = createUserConfirmationAdapters('localhost:3000', tracker).confirmUserAction(
      signReview('0x06'),
    );
    await modalShown();

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
    expect(page.pending()).toEqual([]);
  });

  it('As a product, a request that never reached the frame closes the dialog as today', async () => {
    // Given
    const { confirmUserAction } = pairedPhone();
    const confirmation = confirmUserAction(signReview('0x06'));
    await modalShown();

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
    expect(page.pending()).toEqual([]);
  });

  it('As a user, rejecting a review that went to the phone closes the dialog as today', async () => {
    // Given
    const { tap, confirmUserAction } = pairedPhone();
    tap.fromProduct(requestFrame('a', 'signPayload', signRequest('0x06')));
    const confirmation = confirmUserAction(signReview('0x06'));
    await modalShown();

    // When
    press('cancel');

    // Then
    await expect(confirmation).resolves.toBe(false);
    expect(page.pending()).toEqual([]);
  });

  it('As a user granting an allowance, I wait on my phone and hear it was granted', async () => {
    // Given
    const resources = [{ tag: 'SmartContractAllowance' as const, value: { tag: 'Index' as const, value: 1 } }];
    const { tap, confirmUserAction } = pairedPhone();
    tap.fromProduct(requestFrame('a', 'requestResourceAllocation', { resources }));
    const confirmation = confirmUserAction({
      tag: 'ResourceAllocation',
      value: { callingProductId: 'product.dot', resources },
    });
    await modalShown();

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
    expect(waiting()).toBe(true);
    expect(shownDialog().title).toBe('Resource Allocation');

    // When
    tap.fromCore(responseFrame('a', 'requestResourceAllocation', { ok: { outcomes: ['Allocated'] } }));

    // Then
    const notices = await page.noticesShown(1);
    expect(page.pending()).toEqual([]);
    expect(notices.map(n => n.text)).toEqual(['Allowance granted']);
  });

  it('As a user, allowing account access once waits on the phone and the core hears AllowOnce', async () => {
    // Given
    const { tap, confirmPermission } = pairedPhone();
    tap.fromProduct(
      requestFrame('a', 'getAccount', {
        productAccountId: { dotNsIdentifier: 'other-product.dot', derivationIndex: { tag: 'Index', value: 0 } },
      }),
    );
    const decision = confirmPermission({
      tag: 'AccountAccess',
      value: { requestingProductId: 'product.dot', targetProductId: 'other-product.dot' },
    });
    await modalShown();

    // When
    press('sign');

    // Then
    await expect(decision).resolves.toBe('AllowOnce');
    expect(waiting()).toBe(true);
    expect(shownDialog().title).toBe('Account Access');
  });
});
