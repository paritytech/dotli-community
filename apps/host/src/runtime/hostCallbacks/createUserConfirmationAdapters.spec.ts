// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { UserConfirmation } from '@parity/truapi-host';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { bindRecordingSentry, recordCaptures, type RecordingSentry } from '@dotli/metrics/testing';
import { spans as S } from '@dotli/metrics';
import { withActiveTld } from '@dotli/config';
import { createBlockingModalCoordinator, type BlockingModalCoordinator } from '../createBlockingModalCoordinator.js';
import type { HostPrompts } from '../hostPrompts.js';
import { encodePhoneRequestFrame } from '../../testing/encodePhoneRequestFrame.js';
import { encodePhoneResponseFrame, type PhoneResult } from '../../testing/encodePhoneResponseFrame.js';
import { createPhoneRequestTracker, type PhoneRequestTracker } from '../createPhoneRequestTracker.js';
import { createUserConfirmationAdapters as createAdapters } from './createUserConfirmationAdapters.js';
import type { ModalButton, ModalButtonVariant, ModalView } from '@dotli/ui';
import { SignIcon } from '../../components/icons/SignIcon.js';
import { phoneWaitingView } from '../../components/signing/phoneWaitingView.js';
import { createFakePrompts } from '../hostPrompts.fake.js';
import { createDeferred } from '@dotli/shared';
import { recordLog, resetAllStoresForTests } from '@dotli/shared/testing';

type UserConfirmationReview = Parameters<Required<UserConfirmation>['confirmUserAction']>[0];

type PermissionReview = Parameters<Required<UserConfirmation>['confirmPermission']>[0];

type ButtonKind = 'sign' | 'secondary' | 'cancel';

type StructuredReviewCase = {
  /** What the product asks to confirm. */
  request: string;
  /** The kind of fields the review shows. */
  kind: string;
  /** The review the core hands over. */
  review: UserConfirmationReview;
  /** The dialog's title. */
  title: string;
  /** The dialog's icon, or undefined for none. */
  icon: ModalView<string>['icon'];
  /** The fields the dialog shows, by label. */
  fields: Record<string, string>;
  /** The dialog's buttons as label and variant. */
  footer: [string, ModalButtonVariant][];
  /** Words the dialog shows nowhere. */
  hiddenWords: string[];
  /** The button the user presses. */
  button: ButtonKind;
  /** What the confirmation resolves to. */
  answer: boolean;
};

type ProductSigningCase = {
  /** What the dialog shows for the signing. */
  outcome: string;
  /** The signing review the core hands over. */
  review: UserConfirmationReview;
  /** The fields the dialog shows, by label. */
  fields: Record<string, string>;
  /** The labels of the fields drawn as warnings. */
  warnings: string[];
  /** The button the user presses. */
  button: ButtonKind;
  /** What the confirmation resolves to. */
  answer: boolean;
};

type CreatePageAdaptersParams = {
  /** What the confirmations claim the phone's requests from, a tracker with no request on the way by default. */
  phoneRequests?: PhoneRequestTracker;
};

type CreatePairedPhoneParams = {
  /** The page's prompts, the fake page's by default. */
  prompts?: HostPrompts;
  /** The page's one prompt queue, a new one by default. */
  coordinator?: BlockingModalCoordinator;
  /** The phone's request tracker, one that throws on an undecodable frame by default. */
  tracker?: PhoneRequestTracker;
};

const PRODUCT_ACCOUNT = { dotNsIdentifier: 'product.dot', derivationIndex: { tag: 'Index' as const, value: 0 } };

const SIGNED: PhoneResult = { kind: 'ok', value: { signature: '0x01' } };
const REJECTED: PhoneResult = { kind: 'domain', value: { tag: 'Rejected' } };

const SIGN_FOOTER: [string, ModalButtonVariant][] = [
  ['Cancel', 'danger'],
  ['Sign', 'primary'],
];
const ALLOW_FOOTER: [string, ModalButtonVariant][] = [
  ['Deny', 'danger'],
  ['Allow', 'primary'],
];

let page = createFakePrompts();

afterEach(() => {
  resetAllStoresForTests();
  page = createFakePrompts();
});

describe('user confirmation modal', () => {
  it.each<StructuredReviewCase>([
    {
      request: 'a legacy payload signing',
      kind: 'transaction',
      review: {
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
      },
      title: 'Sign Transaction',
      icon: SignIcon,
      fields: {
        App: 'localhost:3000',
        Signer: '0x2afb6161ad5d4132b6d2362330e1475be90b706b0e68ba344a80e7a1df071304',
        'Genesis Hash': '0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f',
        'Call Data': '0x0000',
        Version: '4',
      },
      footer: SIGN_FOOTER,
      hiddenWords: ['Request'],
      button: 'sign',
      answer: true,
    },
    {
      request: 'a legacy raw signing',
      kind: 'sign-message',
      review: {
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
      },
      title: 'Sign Message',
      icon: SignIcon,
      fields: {
        App: 'localhost:3000',
        Signer: '0x2afb6161ad5d4132b6d2362330e1475be90b706b0e68ba344a80e7a1df071304',
        Message: '0x48656c6c6f2c20776f726c6421',
      },
      footer: SIGN_FOOTER,
      hiddenWords: ['Request'],
      button: 'sign',
      answer: true,
    },
    {
      request: 'a VRF signing',
      kind: 'transcript',
      review: {
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
      },
      title: 'Sign VRF Transcript',
      icon: SignIcon,
      fields: {
        'Requesting product': 'truapi-playground.dot',
        Signer: 'other-product.dot / 4',
        'Transcript label': '0x706f703a61697264726f70',
        'Transcript items': '2',
      },
      footer: SIGN_FOOTER,
      hiddenWords: [],
      button: 'sign',
      answer: true,
    },
    {
      request: 'a product transaction creation',
      kind: 'transaction',
      review: {
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
      },
      title: 'Sign Transaction',
      icon: SignIcon,
      fields: {
        App: 'localhost:3000',
        Signer: 'truapi-playground.dot / 3',
        'Genesis Hash': '0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f',
        'Call Data': '0x0500',
        'Tx Ext Version': '5',
      },
      footer: SIGN_FOOTER,
      hiddenWords: [],
      button: 'sign',
      answer: true,
    },
    {
      request: 'a resource allocation',
      kind: 'resource',
      review: {
        tag: 'ResourceAllocation',
        value: {
          callingProductId: 'localhost:3000',
          resources: [{ tag: 'StatementStoreAllowance' }, { tag: 'AutoSigning' }],
        },
      },
      title: 'Resource Allocation',
      icon: undefined,
      fields: {
        'Requesting product': 'localhost:3000',
        Resources: 'StatementStoreAllowance, AutoSigning',
      },
      footer: [
        ['Cancel', 'danger'],
        ['Allow', 'primary'],
      ],
      hiddenWords: [],
      button: 'sign',
      answer: true,
    },
    {
      request: 'an account alias permission',
      kind: 'product',
      review: {
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
      },
      title: 'Alias Permission',
      icon: undefined,
      fields: {
        'Requesting product': 'truapi-playground.dot',
        'Context product': 'truapix-playground.dot',
        'Context suffix': '0',
        Chain: '0x0000000000000000000000000000000000000000000000000000000000000000',
        'Ring path': 'PalletInstance(42)',
      },
      footer: ALLOW_FOOTER,
      hiddenWords: [],
      button: 'sign',
      answer: true,
    },
    {
      request: 'a proof permission',
      kind: 'ring',
      review: {
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
      },
      title: 'Proof Permission',
      icon: undefined,
      fields: {
        'Requesting product': 'truapi-playground.dot',
        'Context product': 'truapix-playground.dot',
        'Context suffix': '0',
        Chain: '0x0000000000000000000000000000000000000000000000000000000000000000',
        'Ring path': 'PalletInstance(42)',
        Message: '0x4869',
      },
      footer: ALLOW_FOOTER,
      hiddenWords: [],
      button: 'sign',
      answer: true,
    },
    {
      request: 'an account access permission',
      kind: 'product',
      review: {
        tag: 'AccountAccess',
        value: {
          requestingProductId: 'truapi-playground.dot',
          targetProductId: 'other-product.dot',
        },
      },
      title: 'Account Access',
      icon: undefined,
      fields: {
        'Requesting product': 'truapi-playground.dot',
        'Requested account': 'other-product.dot',
      },
      footer: ALLOW_FOOTER,
      hiddenWords: [],
      button: 'sign',
      answer: true,
    },
    {
      request: 'an identity disclosure',
      kind: 'product',
      review: {
        tag: 'IdentityDisclosure',
        value: {
          productId: 'truapi-playground.dot',
        },
      },
      title: 'Identity Disclosure',
      icon: undefined,
      fields: {
        'Requesting product': 'truapi-playground.dot',
      },
      footer: ALLOW_FOOTER,
      hiddenWords: [],
      button: 'sign',
      answer: true,
    },
    // The answer is fixed for the pairing and cached, so the wording has to read as granting access rather than as
    // signing something.
    {
      request: 'a product subtree resolution',
      kind: 'product',
      review: {
        tag: 'ProductSubtree',
        value: {
          productId: 'truapi-playground.dot',
        },
      },
      title: 'Product Account',
      icon: undefined,
      fields: {
        'Requesting product': 'truapi-playground.dot',
      },
      footer: ALLOW_FOOTER,
      hiddenWords: [],
      button: 'cancel',
      answer: false,
    },
  ])(
    'As a dotli integrator, I confirm $request and the host renders it as structured $kind fields',
    async ({ review, title, icon, fields, footer, hiddenWords, button, answer }) => {
      // Given
      const { confirmUserAction } = createPageAdapters();

      // When
      const confirmation = confirmUserAction(review);
      await waitForModal();

      // Then
      expect(readShownReview()).toEqual({ title, icon, fields, warnings: [], footer });
      expect(Object.keys(getModalFields())).not.toContain('Application');
      expect(Object.keys(getModalFields())).not.toContain('Request');
      expect(hiddenWords.filter(word => getModalText().includes(word))).toEqual([]);

      // When
      press(button);

      // Then
      await expect(confirmation).resolves.toBe(answer);
    },
  );

  it.each<ProductSigningCase>([
    {
      outcome: 'a product payload signing and the host renders it with the derived account',
      review: {
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
      },
      fields: {
        App: 'localhost:3000',
        Signer: 'truapi-playground.dot / 2',
        'Genesis Hash': '0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f',
        'Call Data': '0x0500',
        Version: '4',
      },
      warnings: [],
      button: 'sign',
      answer: true,
    },
    {
      outcome: 'an unwatermarked raw signature and the host warns before it',
      review: {
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
      },
      fields: {
        App: 'localhost:3000',
        Signer: 'truapi-playground.dot / 0',
        Message: '0x0304',
        Warning: 'Unprotected signature: may authorize transactions',
      },
      warnings: ['Warning'],
      button: 'sign',
      answer: true,
    },
    {
      outcome: "a signing with another product's account and the host names the product that signs",
      review: {
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
      },
      fields: {
        'Requesting product': 'truapi-playground.dot',
        App: 'localhost:3000',
        Signer: 'other-product.dot / 1',
        Message: '0x0304',
      },
      warnings: [],
      button: 'cancel',
      answer: false,
    },
  ])('As a dotli integrator, I confirm $outcome', async ({ review, fields, warnings, button, answer }) => {
    // Given
    const { confirmUserAction } = createPageAdapters();

    // When
    const confirmation = confirmUserAction(review);
    await waitForModal();

    // Then
    expect(getModalFields()).toEqual(fields);
    expect(
      getShownDialog()
        .fields.filter(f => f.warning === true)
        .map(f => f.label),
    ).toEqual(warnings);

    // When
    press(button);

    // Then
    await expect(confirmation).resolves.toBe(answer);
  });

  it('As a user, I dismiss an identity disclosure dialog and the host rejects the confirmation', async () => {
    // Given
    const { confirmUserAction } = createPageAdapters();
    const review: UserConfirmationReview = {
      tag: 'IdentityDisclosure',
      value: {
        productId: 'truapi-playground.dot',
      },
    };

    const confirmation = confirmUserAction(review);
    await waitForModal();

    // When
    dismissModal();

    // Then
    await expect(confirmation).rejects.toThrow('User dismissed identity disclosure dialog');
  });

  it('As a user, I allow a preimage submission from its dedicated dialog and the host confirms it', async () => {
    // Given
    const { confirmUserAction } = createPageAdapters();

    // When
    const confirmation = confirmUserAction({
      tag: 'PreimageSubmit',
      value: { size: 2048n },
    });
    await waitForModal();

    // Then
    expect(page.getShown()).toEqual({ kind: 'preimage', label: 'localhost:3000', size: 2048 });

    // When
    page.allowPreimage(true);

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it('As a user, I cancel a preimage submission and the host denies it', async () => {
    // Given
    const { confirmUserAction } = createPageAdapters();
    const confirmation = confirmUserAction({
      tag: 'PreimageSubmit',
      value: { size: 512n },
    });
    await waitForModal();

    // When
    page.allowPreimage(false);

    // Then
    await expect(confirmation).resolves.toBe(false);
  });

  it.each<{ label: string; open: () => void; footer: [string, ModalButtonVariant][] }>([
    {
      label: 'an account access prompt and Allow once is highlighted',
      open() {
        void createPageAdapters().confirmPermission({
          tag: 'AccountAccess',
          value: {
            requestingProductId: 'truapi-playground.dot',
            targetProductId: 'other-product.dot',
          },
        });
      },
      footer: [
        ['Deny', 'danger'],
        ['Always allow', 'secondary'],
        ['Allow once', 'primary'],
      ],
    },
    {
      label: 'a per-action confirmation and it keeps two buttons',
      open() {
        void createPageAdapters().confirmUserAction({
          tag: 'AccountAccess',
          value: {
            requestingProductId: 'truapi-playground.dot',
            targetProductId: 'other-product.dot',
          },
        });
      },
      footer: ALLOW_FOOTER,
    },
    {
      label: 'a signing prompt and its Cancel is drawn as the destructive answer',
      open() {
        void createPageAdapters().confirmUserAction({
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
        });
      },
      footer: SIGN_FOOTER,
    },
  ])('As a user, I see $label', async ({ open, footer }) => {
    // Given a page with no prompt on show

    // When the review opens
    open();
    await waitForModal();

    // Then its footer shows the row's buttons
    expect(getFooterVariants()).toEqual(footer);
  });

  it.each<{ label: string; kind: ButtonKind; answer: string }>([
    { label: 'Allow once', kind: 'sign', answer: 'AllowOnce' },
    { label: 'Always allow', kind: 'secondary', answer: 'AllowAlways' },
    { label: 'Deny', kind: 'cancel', answer: 'Deny' },
  ])('As a user, I press $label on an account access prompt and the core hears $answer', async ({ kind, answer }) => {
    // Given
    const decision = createPageAdapters().confirmPermission({
      tag: 'AccountAccess',
      value: {
        requestingProductId: 'truapi-playground.dot',
        targetProductId: 'other-product.dot',
      },
    });
    await waitForModal();

    // When
    press(kind);

    // Then
    await expect(decision).resolves.toBe(answer);
  });

  it('As a user, I allow an identity disclosure and it is allowed once, not remembered', async () => {
    // Given
    const decision = createPageAdapters().confirmPermission({
      tag: 'IdentityDisclosure',
      value: { productId: 'truapi-playground.dot' },
    });
    await waitForModal();

    // When
    press('sign');

    // Then
    await expect(decision).resolves.toBe('AllowOnce');
  });

  it.each<{ label: string; review: PermissionReview; close: () => void; error: string }>([
    {
      label: 'dismiss an identity disclosure permission and no decision',
      review: { tag: 'IdentityDisclosure', value: { productId: 'truapi-playground.dot' } },
      close: dismissModal,
      error: 'User dismissed identity disclosure dialog',
    },
    {
      label: 'dismiss an account access prompt and no decision',
      review: {
        tag: 'AccountAccess',
        value: {
          requestingProductId: 'truapi-playground.dot',
          targetProductId: 'other-product.dot',
        },
      },
      close: dismissModal,
      error: 'User dismissed permission dialog',
    },
    {
      label: 'cancel a preimage permission and no denial',
      review: { tag: 'PreimageSubmit', value: { size: 512n } },
      close() {
        page.allowPreimage(false);
      },
      error: 'User cancelled preimage submission',
    },
  ])('As a user, I $label is recorded', async ({ review, close, error }) => {
    // Given a permission review on show
    const decision = createPageAdapters().confirmPermission(review);
    await waitForModal();

    // When
    close();

    // Then
    await expect(decision).rejects.toThrow(error);
  });

  it('As a user, I allow a preimage permission and it is allowed once, not remembered', async () => {
    // Given
    const decision = createPageAdapters().confirmPermission({
      tag: 'PreimageSubmit',
      value: { size: 512n },
    });
    await waitForModal();

    // When
    page.allowPreimage(true);

    // Then
    await expect(decision).resolves.toBe('AllowOnce');
  });

  it('As a user, I press Escape on a one-off review and it answers no without throwing', async () => {
    // Given
    const confirmation = createPageAdapters().confirmUserAction({
      tag: 'AccountAccess',
      value: {
        requestingProductId: 'truapi-playground.dot',
        targetProductId: 'other-product.dot',
      },
    });
    await waitForModal();

    // When
    dismissModal();

    // Then
    await expect(confirmation).resolves.toBe(false);
  });
});

describe('waiting on the phone', () => {
  it('As a user with a paired phone, I approve a signing and the core hears it while the dialog waits on the phone', async () => {
    // Given
    const { tap, confirmUserAction } = createPairedPhone();
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signPayload', body: buildSignRequest('0x06') }));
    const confirmation = confirmUserAction(buildSignReview('0x06'));
    await waitForModal();

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
    expect(isWaiting()).toBe(true);
    expect(getShownDialog().title).toBe('Sign Transaction');
    expect(getShownDialog().icon).toBe(SignIcon);
  });

  it('As a user, I sign on my phone and the waiting step closes while I see it signed', async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { tap, confirmation } = await signForPhone();
    await confirmation;

    // When
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'a', method: 'signPayload', result: SIGNED }));
    const notices = await page.waitForNotices(1);

    // Then
    expect(page.listPending()).toEqual([]);
    expect(notices.map(n => n.text)).toEqual(['Sign Transaction: signed in Polkadot App']);
    expect(notices[0]?.label).toBe(withActiveTld('localhost:3000'));
    expect(sentry.counted(S.PHONE_REQUEST)).toEqual([{ outcome: 'ok', reason: 'signPayload', background: 'no' }]);
  });

  it('As a user, I wait in background and still hear the outcome', async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { tap, confirmation } = await signForPhone();
    await confirmation;

    // When
    page.settleReview('background');

    // Then
    expect(page.listPending()).toEqual([]);

    // When
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'a', method: 'signPayload', result: REJECTED }));
    const notices = await page.waitForNotices(1);

    // Then
    expect(page.listPending()).toEqual([]);
    expect(notices.map(n => n.text)).toEqual(['Rejected in Polkadot App']);
    expect(sentry.counted(S.PHONE_REQUEST)).toEqual([{ outcome: 'refused', reason: 'signPayload', background: 'yes' }]);
  });

  it('As a user, I press Escape on the waiting step and it goes to the background, rejecting nothing', async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { tap, confirmation } = await signForPhone();

    // When
    dismissModal();

    // Then
    await expect(confirmation).resolves.toBe(true);
    expect(page.listPending()).toEqual([]);
    expect(page.notices).toEqual([]);

    // When
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'a', method: 'signPayload', result: SIGNED }));
    const notices = await page.waitForNotices(1);

    // Then
    expect(notices.map(n => n.text)).toEqual(['Sign Transaction: signed in Polkadot App']);
    expect(sentry.counted(S.PHONE_REQUEST)).toEqual([{ outcome: 'ok', reason: 'signPayload', background: 'yes' }]);
  });

  it('As a user, I send the wait to the background and the next prompt shows', async () => {
    // Given
    const { tap, confirmUserAction } = createPairedPhone();
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signPayload', body: buildSignRequest('0x06') }));
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'b', method: 'signPayload', body: buildSignRequest('0x07') }));
    const first = confirmUserAction(buildSignReview('0x06'));
    const second = confirmUserAction(buildSignReview('0x07'));
    await waitForModal();

    // When
    press('sign');

    // Then
    await expect(first).resolves.toBe(true);
    expect(page.listPending()).toHaveLength(1);
    expect(isWaiting()).toBe(true);

    // When
    page.settleReview('background');
    await page.waitForPrompt({
      matches: prompt => prompt.kind === 'review' && prompt.dialog.buttons[0]?.label === 'Cancel',
    });

    // Then
    expect(page.listPending()).toHaveLength(1);

    // When
    press('sign');

    // Then
    await expect(second).resolves.toBe(true);
    expect(isWaiting()).toBe(true);
  });

  it('As a user, I see the host torn down while I wait and the waiting step closes, the prompt slot frees and the request is counted once', async () => {
    // Given
    const coordinator = createBlockingModalCoordinator();
    const { tracker, scope, confirmation } = await signForPhone({ coordinator });
    await confirmation;
    const next = createAdapters({
      label: 'localhost:3000',
      prompts: page.prompts,
      modalScope: coordinator.createScope(),
      phoneRequests: createPhoneRequestTracker(),
    }).confirmUserAction(buildSignReview('0x07'));

    // When
    scope.dispose();
    await page.waitForPrompt({
      matches: prompt => prompt.kind === 'review' && prompt.dialog.buttons[0]?.label === 'Cancel',
    });

    // Then
    expect(page.listPending()).toHaveLength(1);

    // When
    press('sign');

    // Then
    await expect(next).resolves.toBe(true);

    // When
    const { sentry, recorded } = bindNextRecord();
    tracker.dispose();
    await recorded;

    // Then
    expect(sentry.counted(S.PHONE_REQUEST)).toEqual([{ outcome: 'gone', reason: 'signPayload', background: 'no' }]);
    expect(page.notices).toEqual([]);
  });

  it('As a user whose toast fails to show, I sign on my phone and the failure is reported while the request is still counted', async () => {
    // Given
    const errors: unknown[] = [];
    const captured = recordCaptures({ onFinished: onTestFinished, errors });
    const { sentry, recorded } = bindNextRecord();
    const { tap, confirmation } = await signForPhone({
      prompts: {
        ...page.prompts,
        notify: () => {
          throw new Error('toast stack gone');
        },
      },
    });
    await confirmation;

    // When
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'a', method: 'signPayload', result: SIGNED }));
    await recorded;
    await page.waitForClearedScreen();

    // Then
    expect(sentry.counted(S.PHONE_REQUEST)).toEqual([{ outcome: 'ok', reason: 'signPayload', background: 'no' }]);
    expect(captured.map(c => c.step)).toEqual(['phone_request_notice']);
    expect(errors).toEqual([new Error('toast stack gone')]);
  });

  it('As a user, I get an answer that does not decode and the wait ends, is reported and is counted once as undecodable', async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const captured = recordCaptures({ onFinished: onTestFinished });
    recordLog({ onFinished: onTestFinished });
    const { tap, confirmation } = await signForPhone({ tracker: createPhoneRequestTracker() });
    await confirmation;
    const answer = encodePhoneResponseFrame({ requestId: 'a', method: 'signPayload', result: SIGNED });

    // When
    tap.fromCore(answer.subarray(0, answer.length - 3));
    const notices = await page.waitForNotices(1);

    // Then
    expect(page.listPending()).toEqual([]);
    expect(notices.map(n => n.text)).toEqual(["Polkadot App didn't complete the request: undecodable"]);
    expect(captured.map(c => c.step)).toEqual(['phone_request']);
    expect(sentry.counted(S.PHONE_REQUEST)).toEqual([
      { outcome: 'undecodable', reason: 'signPayload', background: 'no' },
    ]);
  });

  it.each<{ label: string; openReview: () => Promise<boolean> }>([
    {
      label: 'user whose phone lookup throws, I approve a review and it closes as today and answers the core',
      openReview() {
        recordCaptures({ onFinished: onTestFinished });
        recordLog({ onFinished: onTestFinished });
        const tracker = createPhoneRequestTracker();
        const { confirmUserAction } = createPairedPhone({
          tracker: {
            ...tracker,
            claim: () => {
              throw new Error('tracker broken');
            },
          },
        });
        return confirmUserAction(buildSignReview('0x06'));
      },
    },
    {
      label: 'local wallet user, I sign and the dialog closes as today',
      openReview() {
        // A local wallet core, whose tracker is disposed as it has no phone.
        const tracker = createPhoneRequestTracker();
        tracker.dispose();
        tracker
          .connect()
          .fromProduct(
            encodePhoneRequestFrame({ requestId: 'a', method: 'signPayload', body: buildSignRequest('0x06') }),
          );
        return createPageAdapters({ phoneRequests: tracker }).confirmUserAction(buildSignReview('0x06'));
      },
    },
    {
      label: 'user, I approve a request that never reached the frame and the dialog closes as today',
      openReview() {
        const { confirmUserAction } = createPairedPhone();
        return confirmUserAction(buildSignReview('0x06'));
      },
    },
  ])('As a $label', async ({ openReview }) => {
    // Given the review on show
    const confirmation = openReview();
    await waitForModal();

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
    expect(page.listPending()).toEqual([]);
  });

  it('As a user, I get the phone answer as the step opens and it closes at once with one toast', async () => {
    // Given
    const { tap, confirmUserAction } = createPairedPhone();
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signPayload', body: buildSignRequest('0x06') }));
    const confirmation = confirmUserAction(buildSignReview('0x06'));
    await waitForModal();

    // When
    press('sign');
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'a', method: 'signPayload', result: SIGNED }));
    const confirmed = await confirmation;
    await page.waitForClearedScreen();
    const notices = await page.waitForNotices(1);

    // Then
    expect(confirmed).toBe(true);
    expect(notices.map(n => n.text)).toEqual(['Sign Transaction: signed in Polkadot App']);
  });

  it('As a user, I lose the connection while I wait and the waiting step closes without a toast', async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const { tracker, confirmation } = await signForPhone();
    await confirmation;

    // When
    tracker.dispose();
    await page.waitForClearedScreen();

    // Then
    expect(page.notices).toEqual([]);
    expect(sentry.counted(S.PHONE_REQUEST)).toEqual([{ outcome: 'gone', reason: 'signPayload', background: 'no' }]);
  });

  it('As a local wallet user, I approve a review that cannot be matched to a request and nothing is reported', async () => {
    // Given a local wallet core's disposed tracker, and a review whose request would not encode
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const captured = recordCaptures({ onFinished: onTestFinished });
    const tracker = createPhoneRequestTracker();
    tracker.dispose();
    const confirmation = createPageAdapters({ phoneRequests: tracker }).confirmUserAction({
      tag: 'SignVrf',
      value: {
        callingProductId: 'product.dot',
        // An item with none of its fields, so the request does not encode.
        request: { account: PRODUCT_ACCOUNT, transcriptLabel: '0xaa', items: [{} as never] },
      },
    });
    await waitForModal();

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
    expect(page.listPending()).toEqual([]);
    expect(sentry.counted(S.PHONE_REQUEST)).toEqual([]);
    expect(captured).toEqual([]);
  });

  it('As a user, I reject a review that went to the phone and the dialog closes as today', async () => {
    // Given
    const { tap, confirmUserAction } = createPairedPhone();
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signPayload', body: buildSignRequest('0x06') }));
    const confirmation = confirmUserAction(buildSignReview('0x06'));
    await waitForModal();

    // When
    press('cancel');

    // Then
    await expect(confirmation).resolves.toBe(false);
    expect(page.listPending()).toEqual([]);
  });

  it('As a user granting an allowance, I wait on my phone and hear it was granted', async () => {
    // Given
    const resources = [{ tag: 'SmartContractAllowance' as const, value: { tag: 'Index' as const, value: 1 } }];
    const { tap, confirmUserAction } = createPairedPhone();
    tap.fromProduct(
      encodePhoneRequestFrame({ requestId: 'a', method: 'requestResourceAllocation', body: { resources } }),
    );
    const confirmation = confirmUserAction({
      tag: 'ResourceAllocation',
      value: { callingProductId: 'product.dot', resources },
    });
    await waitForModal();

    // When
    press('sign');

    // Then
    await expect(confirmation).resolves.toBe(true);
    expect(isWaiting()).toBe(true);
    expect(getShownDialog().title).toBe('Resource Allocation');

    // When
    tap.fromCore(
      encodePhoneResponseFrame({
        requestId: 'a',
        method: 'requestResourceAllocation',
        result: { kind: 'ok', value: { outcomes: ['Allocated'] } },
      }),
    );
    const notices = await page.waitForNotices(1);

    // Then
    expect(page.listPending()).toEqual([]);
    expect(notices.map(n => n.text)).toEqual(['Allowance granted']);
  });

  it('As a user granting an allowance, I approve it and the waiting step asks me to approve on my phone, not to sign', async () => {
    // Given
    const resources = [{ tag: 'SmartContractAllowance' as const, value: { tag: 'Index' as const, value: 1 } }];
    const { tap, confirmUserAction } = createPairedPhone();
    tap.fromProduct(
      encodePhoneRequestFrame({ requestId: 'a', method: 'requestResourceAllocation', body: { resources } }),
    );
    void confirmUserAction({ tag: 'ResourceAllocation', value: { callingProductId: 'product.dot', resources } });
    await waitForModal();

    // When
    press('sign');

    // Then
    expect(isWaiting()).toBe(true);
    expect(getShownDialog().body).toBe(phoneWaitingView({ title: 'Resource Allocation', ask: 'approve' }).body);
    expect(getShownDialog().body).not.toBe(phoneWaitingView({ title: 'Resource Allocation', ask: 'sign' }).body);
  });

  it('As a user, I allow account access once and the core hears AllowOnce while the dialog waits on the phone', async () => {
    // Given
    const { tap, confirmPermission } = createPairedPhone();
    tap.fromProduct(
      encodePhoneRequestFrame({
        requestId: 'a',
        method: 'getAccount',
        body: {
          productAccountId: { dotNsIdentifier: 'other-product.dot', derivationIndex: { tag: 'Index', value: 0 } },
        },
      }),
    );
    const decision = confirmPermission({
      tag: 'AccountAccess',
      value: { requestingProductId: 'product.dot', targetProductId: 'other-product.dot' },
    });
    await waitForModal();

    // When
    press('sign');

    // Then
    await expect(decision).resolves.toBe('AllowOnce');
    expect(isWaiting()).toBe(true);
    expect(getShownDialog().title).toBe('Account Access');
  });
});

/** The adapters for localhost:3000 with their dialogs shown through the page's fake prompts. */
function createPageAdapters({ phoneRequests = createPhoneRequestTracker() }: CreatePageAdaptersParams = {}): ReturnType<
  typeof createAdapters
> {
  return createAdapters({
    label: 'localhost:3000',
    prompts: page.prompts,
    modalScope: createBlockingModalCoordinator().createScope(),
    phoneRequests,
  });
}

/** The review on screen. */
function getShownDialog(): ModalView<string> {
  return page.getShownReview();
}

function waitForModal(): Promise<unknown> {
  return page.waitForPrompt();
}

function dismissModal(): void {
  page.dismiss();
}

function getModalFields(): Record<string, string> {
  return Object.fromEntries(getShownDialog().fields.map(field => [field.label, field.value]));
}

/** Every word the dialog shows. */
function getModalText(): string {
  const view = getShownDialog();
  return [view.title, ...view.fields.flatMap(f => [f.label, f.value]), ...view.buttons.map(b => b.label)].join(' ');
}

/** The review on screen as a table case compares it: its title, icon, fields, warned field labels and buttons. */
function readShownReview() {
  const view = getShownDialog();
  return {
    title: view.title,
    icon: view.icon,
    fields: getModalFields(),
    warnings: view.fields.filter(field => field.warning === true).map(field => field.label),
    footer: getFooterVariants(),
  };
}

function getFooterVariants(): [string, ModalButtonVariant][] {
  return getShownDialog().buttons.map(b => [b.label, b.variant]);
}

/** The shown dialog's main, lesser or rejecting button. */
function findButton(kind: ButtonKind): ModalButton<string> {
  const variants = getButtonVariants(kind);
  const found = getShownDialog().buttons.find(b => variants.includes(b.variant));
  if (found === undefined) {
    throw new Error(`expected a ${kind} button`);
  }
  return found;
}

function getButtonVariants(kind: ButtonKind): ModalButtonVariant[] {
  switch (kind) {
    case 'sign':
      return ['primary'];
    case 'secondary':
      return ['secondary'];
    case 'cancel':
      return ['danger', 'cancel'];
  }
}

function press(kind: ButtonKind): void {
  page.settleReview(findButton(kind).result);
}

function buildSignRequest(nonce: `0x${string}`) {
  return {
    account: PRODUCT_ACCOUNT,
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

function buildSignReview(nonce: `0x${string}`): UserConfirmationReview {
  return {
    tag: 'SignPayload',
    value: { tag: 'Product', value: { callingProductId: 'product.dot', request: buildSignRequest(nonce) } },
  };
}

/** A paired phone's adapters, whose product frame relays through `tap`. */
function createPairedPhone({
  prompts = page.prompts,
  coordinator = createBlockingModalCoordinator(),
  tracker = createPhoneRequestTracker({
    reportUndecodable: ({ method, error }) => {
      throw new Error(`${method} frame did not decode`, { cause: error });
    },
  }),
}: CreatePairedPhoneParams = {}) {
  const tap = tracker.connect();
  const scope = coordinator.createScope();
  const adapters = createAdapters({ label: 'localhost:3000', prompts, modalScope: scope, phoneRequests: tracker });
  return { tracker, tap, scope, ...adapters };
}

/** A paired phone whose sign request the user signed in the dialog, so the review goes to the phone. */
async function signForPhone(params?: CreatePairedPhoneParams) {
  const phone = createPairedPhone(params);
  phone.tap.fromProduct(
    encodePhoneRequestFrame({ requestId: 'a', method: 'signPayload', body: buildSignRequest('0x06') }),
  );
  const confirmation = phone.confirmUserAction(buildSignReview('0x06'));
  await waitForModal();
  press('sign');
  return { ...phone, confirmation };
}

/** Resolves on the next metric recorded, so a spec waits on the count rather than polling. */
function bindNextRecord(): { sentry: RecordingSentry; recorded: Promise<void> } {
  const recorded = createDeferred<undefined>();
  const sentry = bindRecordingSentry({
    onFinished: onTestFinished,
    onRecord: () => {
      recorded.resolve(undefined);
    },
  });
  return { sentry, recorded: recorded.promise };
}

/** Whether the dialog on screen is the waiting step. */
function isWaiting(): boolean {
  return page.getShownReview().buttons[0]?.label === 'Wait in background';
}
