import type { PreimageSubmitReview, UserConfirmationReview } from '@parity/truapi-host';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUserConfirmationAdapters } from '../src/host-callbacks/UserConfirmation.js';
import { createBlockingModalCoordinator } from '../src/blocking-modal-queue.js';
import * as network from '@dotli/config';
import { hexToBytes } from '@parity/truapi/scale';
import { NetworkName } from '../../config/src/network.js';
import { overlaysReady, resetOverlays } from './helpers/overlays.js';
import { byTestId, query } from './support.js';

const PREIMAGE_REVIEW: PreimageSubmitReview = {
  size: 2048n,
  productId: 'localhost:3000',
  rootPublicKey: `0x${'01'.repeat(32)}`,
  genesisHash: `0x${'02'.repeat(32)}`,
  automaticMaxBytes: 262144n,
  automaticMaxUploads: 4,
  automaticWindowSeconds: 3600,
};

afterEach(() => {
  vi.restoreAllMocks();
  resetOverlays();
  document.body.replaceChildren();
});

function modalFields(): Record<string, string> {
  return Object.fromEntries(
    Array.from(document.querySelectorAll('[data-testid="signing-field"]')).map(field => {
      const label = byTestId('signing-field-label', field).textContent;
      const value = byTestId('signing-field-value', field).textContent;
      return [label, value];
    }),
  );
}

describe('user confirmation modal', () => {
  it('reviews each main-purse spend separately without rounding u64 cents', async () => {
    const services = network.NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO];
    vi.spyOn(network, 'getActiveServicesConfig').mockReturnValue(services);
    const { confirmUserAction } = createUserConfirmationAdapters('egui-chat.paseo');
    const review = {
      tag: 'MainPurseChatPayment',
      value: {
        callingProductId: 'egui-chat.paseo',
        recipientIdentity: new Uint8Array(32).fill(7),
        recipientUsername: 'recipient.paseo',
        amountCents: 9007199254740993n,
        maxDebitCents: 9007199254740994n,
        genesisHash: hexToBytes(services.people.genesis),
        coinageInstanceId: 0,
        operationId: new Uint8Array(32).fill(9),
      },
    } satisfies UserConfirmationReview;
    const first = confirmUserAction(review);
    await overlaysReady();
    expect(modalFields()).toMatchObject({
      'Requesting product': 'egui-chat.paseo',
      'Recipient identity': `0x${'07'.repeat(32)}`,
      'Recipient amount': '90071992547409.93 pUSD',
      'Maximum purse debit (including fees)': '90071992547409.94 pUSD',
      'Chain genesis': services.people.genesis,
      'Coinage asset instance': '0',
      'Payment operation': `0x${'09'.repeat(32)}`,
    });
    byTestId('signing-btn-sign').click();
    await expect(first).resolves.toBe(true);
    const second = confirmUserAction({
      ...review,
      value: { ...review.value, operationId: new Uint8Array(32).fill(10) },
    });
    await overlaysReady();
    expect(document.querySelector('[data-testid="signing-modal"]')).not.toBeNull();
    byTestId('signing-btn-cancel').click();
    await expect(second).resolves.toBe(false);
  });

  it('does not offer approval for a payment on an unconfigured chain or asset', async () => {
    const services = network.NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO];
    vi.spyOn(network, 'getActiveServicesConfig').mockReturnValue(services);
    const { confirmUserAction } = createUserConfirmationAdapters('egui-chat.paseo');
    const value = {
      callingProductId: 'egui-chat.paseo',
      recipientIdentity: new Uint8Array(32).fill(7),
      amountCents: 1n,
      maxDebitCents: 1n,
      genesisHash: hexToBytes(services.people.genesis),
      coinageInstanceId: 0,
      operationId: new Uint8Array(32).fill(9),
    };
    await expect(
      confirmUserAction({
        tag: 'MainPurseChatPayment',
        value: { ...value, genesisHash: new Uint8Array(32) },
      }),
    ).rejects.toThrow();
    await expect(
      confirmUserAction({
        tag: 'MainPurseChatPayment',
        value: { ...value, coinageInstanceId: 1 },
      }),
    ).rejects.toThrow();
    expect(document.querySelector('[data-testid="signing-modal"]')).toBeNull();
  });

  it('As a dotli integrator, the host shows concurrent confirmation requests one at a time', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');

    // When
    const accountAccess = confirmUserAction({
      tag: 'AccountAccess',
      value: {
        requestingProductId: 'truapi-playground.dot',
        targetProductId: 'other-product.dot',
      },
    });
    const identityDisclosure = confirmUserAction({
      tag: 'IdentityDisclosure',
      value: { productId: 'truapi-playground.dot' },
    });
    await overlaysReady();

    // Then
    expect(document.querySelectorAll('[data-testid="signing-modal-backdrop"]')).toHaveLength(1);
    expect(query(byTestId('signing-modal'), 'h2').textContent).toBe('Account Access');

    // When
    byTestId('signing-btn-sign').click();

    // Then
    await expect(accountAccess).resolves.toBe(true);
    await overlaysReady();

    // Then
    expect(document.querySelectorAll('[data-testid="signing-modal-backdrop"]')).toHaveLength(1);
    expect(query(byTestId('signing-modal'), 'h2').textContent).toBe('Identity Disclosure');

    // When
    byTestId('signing-btn-sign').click();

    // Then
    await expect(identityDisclosure).resolves.toBe(true);
    await overlaysReady();
    expect(document.querySelector('[data-testid="signing-modal-backdrop"]')).toBeNull();
  });

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
    await overlaysReady();

    // Then
    expect(modalFields()).toEqual({
      App: 'localhost:3000',
      Signer: '0x2afb6161ad5d4132b6d2362330e1475be90b706b0e68ba344a80e7a1df071304',
      'Genesis Hash': '0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f',
      'Call Data': '0x0000',
      Version: '4',
    });
    expect(document.body.textContent).not.toContain('Request');

    // When
    byTestId('signing-btn-sign').click();

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
    await overlaysReady();

    // Then
    expect(modalFields()).toEqual({
      App: 'localhost:3000',
      Signer: 'truapi-playground.dot / 2',
      'Genesis Hash': '0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f',
      'Call Data': '0x0500',
      Version: '4',
    });

    // When
    byTestId('signing-btn-sign').click();

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it('shows protected signing bytes without double-wrapping an existing watermark', async () => {
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    const signedBytes = '0x3c42797465733e68693c2f42797465733e';
    for (const bytes of ['0x6869', signedBytes] as const) {
      const confirmation = confirmUserAction({
        tag: 'SignRaw',
        value: {
          tag: 'LegacyAccount',
          value: {
            request: {
              signer: '0x2afb6161ad5d4132b6d2362330e1475be90b706b0e68ba344a80e7a1df071304',
              payload: { tag: 'Bytes', value: { bytes } },
            },
            watermarked: true,
          },
        },
      });
      await overlaysReady();
      expect(modalFields()['Message']).toBe(signedBytes);
      expect(document.querySelector('[data-testid="signing-field"][data-warning]')).toBeNull();
      byTestId('signing-btn-sign').click();
      await expect(confirmation).resolves.toBe(true);
    }
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
    await overlaysReady();

    // Then
    expect(modalFields()).toEqual({
      App: 'localhost:3000',
      Signer: 'truapi-playground.dot / 0',
      Message: '0x0304',
      Warning: 'Unprotected signature: may authorize transactions',
    });
    expect(
      query(document, '[data-testid="signing-field"][data-warning] [data-testid="signing-field-label"]').textContent,
    ).toBe('Warning');

    // When
    byTestId('signing-btn-sign').click();

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
    await overlaysReady();

    // Then
    expect(modalFields()).toMatchObject({
      'Requesting product': 'truapi-playground.dot',
      Signer: 'other-product.dot / 1',
    });

    // When
    byTestId('signing-btn-cancel').click();

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
    await overlaysReady();

    // Then
    expect(modalFields()).toEqual({
      'Requesting product': 'truapi-playground.dot',
      Signer: 'other-product.dot / 4',
      'Transcript label': '0x706f703a61697264726f70',
      'Transcript items': '2',
    });

    // When
    byTestId('signing-btn-sign').click();

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
    await overlaysReady();

    // Then
    expect(modalFields()).toEqual({
      App: 'localhost:3000',
      Signer: 'truapi-playground.dot / 3',
      'Genesis Hash': '0xbf0488dbe9daa1de1c08c5f743e26fdc2a4ecd74cf87dd1b4b1eeb99ae4ef19f',
      'Call Data': '0x0500',
      'Tx Ext Version': '5',
    });

    // When
    byTestId('signing-btn-sign').click();

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
    await overlaysReady();

    // Then
    const fields = modalFields();
    expect(fields).toEqual({
      'Requesting product': 'localhost:3000',
      Resources: 'StatementStoreAllowance, AutoSigning',
    });

    // When
    byTestId('signing-btn-sign').click();

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
    await overlaysReady();

    // Then
    const fields = modalFields();
    expect(fields).toEqual({
      'Requesting product': 'truapi-playground.dot',
      'Context product': 'truapix-playground.dot',
      'Context suffix': '0',
      Chain: '0x0000000000000000000000000000000000000000000000000000000000000000',
      'Ring path': 'PalletInstance(42)',
    });

    // When
    byTestId('signing-btn-sign').click();

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
    await overlaysReady();

    // Then
    expect(modalFields()).toEqual({
      'Requesting product': 'truapi-playground.dot',
      'Context product': 'truapix-playground.dot',
      'Context suffix': '0',
      Chain: '0x0000000000000000000000000000000000000000000000000000000000000000',
      'Ring path': 'PalletInstance(42)',
      Message: '0x4869',
    });

    // When
    byTestId('signing-btn-sign').click();

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
    await overlaysReady();

    // Then
    const fields = modalFields();
    expect(fields).toEqual({
      'Requesting product': 'truapi-playground.dot',
      'Requested account': 'other-product.dot',
    });

    // When
    byTestId('signing-btn-sign').click();

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
    await overlaysReady();

    // Then
    const fields = modalFields();
    expect(fields).toEqual({
      'Requesting product': 'truapi-playground.dot',
    });

    // When
    byTestId('signing-btn-sign').click();

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
    await overlaysReady();

    // Then
    expect(modalFields()).toEqual({
      'Requesting product': 'truapi-playground.dot',
    });

    // When
    byTestId('signing-btn-cancel').click();

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
    await overlaysReady();

    // When
    byTestId('signing-modal-backdrop').click();

    // Then
    await expect(confirmation).rejects.toThrow('User dismissed identity disclosure dialog');
  });

  it('As a dotli integrator, the host allows preimage submission from its dedicated dialog', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    // When
    const confirmation = confirmUserAction({
      tag: 'PreimageSubmit',
      value: PREIMAGE_REVIEW,
    });
    await overlaysReady();

    // Then
    expect(document.querySelector('[data-testid="signing-btn-secondary"]')).toBeNull();

    // When
    byTestId('signing-btn-sign').click();

    // Then
    await expect(confirmation).resolves.toBe(true);
  });

  it('As a dotli integrator, the host denies preimage submission when the user cancels', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    // When
    const confirmation = confirmUserAction({
      tag: 'PreimageSubmit',
      value: { ...PREIMAGE_REVIEW, size: 512n },
    });
    await overlaysReady();

    // When
    byTestId('signing-btn-cancel').click();

    // Then
    await expect(confirmation).resolves.toBe(false);
  });

  it.each([
    ['signing-btn-sign', 'AllowOnce'],
    ['signing-btn-secondary', 'AllowAlways'],
    ['signing-btn-cancel', 'Deny'],
  ] as const)('returns the actual preimage permission decision for %s', async (testId, expected) => {
    const { confirmPermission } = createUserConfirmationAdapters('localhost:3000');
    const confirmation = confirmPermission({ tag: 'PreimageSubmit', value: PREIMAGE_REVIEW });
    await overlaysReady();
    byTestId(testId).click();
    await expect(confirmation).resolves.toBe(expected);
  });

  it('cancels active and queued upload reviews when their host is disposed', async () => {
    const scope = createBlockingModalCoordinator().createScope();
    const { confirmPermission } = createUserConfirmationAdapters('localhost:3000', scope);
    const active = confirmPermission({ tag: 'PreimageSubmit', value: PREIMAGE_REVIEW });
    const queued = confirmPermission({ tag: 'PreimageSubmit', value: PREIMAGE_REVIEW });
    const activeRejected = expect(active).rejects.toMatchObject({ name: 'AbortError' });
    const queuedRejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await overlaysReady();
    const staleGrant = byTestId('signing-btn-secondary');
    scope.dispose();
    staleGrant.click();
    await Promise.all([activeRejected, queuedRejected]);
    expect(document.querySelector('[data-testid="signing-modal"]')).toBeNull();
  });

  it('As a dotli user, allowing account access once is not remembered', async () => {
    // Given
    const decision = createUserConfirmationAdapters('localhost:3000').confirmPermission({
      tag: 'AccountAccess',
      value: {
        requestingProductId: 'truapi-playground.dot',
        targetProductId: 'other-product.dot',
      },
    });
    await overlaysReady();

    // When
    byTestId('signing-btn-sign').click();

    // Then
    await expect(decision).resolves.toBe('AllowOnce');
  });

  it('As a dotli user, always allowing account access is remembered', async () => {
    // Given
    const decision = createUserConfirmationAdapters('localhost:3000').confirmPermission({
      tag: 'AccountAccess',
      value: {
        requestingProductId: 'truapi-playground.dot',
        targetProductId: 'other-product.dot',
      },
    });
    await overlaysReady();

    // When
    byTestId('signing-btn-secondary').click();

    // Then
    await expect(decision).resolves.toBe('AllowAlways');
  });

  it('As a dotli user, denying account access is remembered', async () => {
    // Given
    const decision = createUserConfirmationAdapters('localhost:3000').confirmPermission({
      tag: 'AccountAccess',
      value: {
        requestingProductId: 'truapi-playground.dot',
        targetProductId: 'other-product.dot',
      },
    });
    await overlaysReady();

    // When
    byTestId('signing-btn-cancel').click();

    // Then
    await expect(decision).resolves.toBe('Deny');
  });

  it('As a dotli user, allowing identity disclosure once is not remembered', async () => {
    // Given
    const decision = createUserConfirmationAdapters('localhost:3000').confirmPermission({
      tag: 'IdentityDisclosure',
      value: { productId: 'truapi-playground.dot' },
    });
    await overlaysReady();

    // When
    byTestId('signing-btn-sign').click();

    // Then
    await expect(decision).resolves.toBe('AllowOnce');
  });

  it('As a dotli user, dismissing identity disclosure records no decision', async () => {
    // Given
    const decision = createUserConfirmationAdapters('localhost:3000').confirmPermission({
      tag: 'IdentityDisclosure',
      value: { productId: 'truapi-playground.dot' },
    });
    await overlaysReady();

    // When
    byTestId('signing-modal-backdrop').click();

    // Then
    await expect(decision).rejects.toThrow('User dismissed identity disclosure dialog');
  });

  it('As a dotli user, always allowing profile disclosure is remembered', async () => {
    // Given
    const decision = createUserConfirmationAdapters('localhost:3000').confirmPermission({
      tag: 'ProfileDisclosure',
      value: { productId: 'egui-chat.dot' },
    });
    await overlaysReady();

    // When
    byTestId('signing-btn-secondary').click();

    // Then
    await expect(decision).resolves.toBe('AllowAlways');
  });

  it('As a dotli user, dismissing profile disclosure records no decision', async () => {
    // Given
    const decision = createUserConfirmationAdapters('localhost:3000').confirmPermission({
      tag: 'ProfileDisclosure',
      value: { productId: 'egui-chat.dot' },
    });
    await overlaysReady();

    // When
    byTestId('signing-modal-backdrop').click();

    // Then
    await expect(decision).rejects.toThrow('User dismissed permission dialog');
  });

  it('As a dotli user, the confirmation dialog is announced as a dialog and dismissed with Escape', async () => {
    // Given
    const { confirmUserAction } = createUserConfirmationAdapters('localhost:3000');
    const accepted = confirmUserAction({
      tag: 'AccountAccess',
      value: { requestingProductId: 'a.dot', targetProductId: 'b.dot' },
    });
    await overlaysReady();

    // Then
    expect(byTestId('signing-modal-backdrop').tagName).toBe('DIALOG');

    // When: the key goes to the focused element, as a real one does.
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );

    // Then
    await expect(accepted).resolves.toBe(false);
  });
});
