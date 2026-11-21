// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect, openHostPlayground } from '../../../../../tests/e2e/fixtures/paired.js';
import { runTest, runTestExpectSuccess } from '../../../../../tests/e2e/helpers/runTest.js';
import { runWebSignedTest, type HostDialog } from '../../../../../tests/e2e/helpers/signing.js';
import { productOrigin } from '../../../../../tests/e2e/fixtures/origin.js';

// Not `describe.serial`, which would skip every test after the first failure. A failure costs a fresh worker instead.

// The host dialogs these tests expect, by the title the host draws. A once answer leaves no grant behind the test.
const PERMISSION_ONCE: HostDialog = { title: 'Permission request', answer: 'Allow once' };
const IDENTITY_ONCE: HostDialog = { title: 'Identity disclosure', answer: 'Allow once' };
const ALLOCATION: HostDialog = { title: 'Approve an allowance', answer: 'Allow' };
const SIGN_MESSAGE: HostDialog = { title: 'Sign message', answer: 'Sign' };
const SIGN_TRANSACTION: HostDialog = { title: 'Sign transaction', answer: 'Sign' };

test.describe('dot.li > host-playground.dot', () => {
  test.describe('Accounts', () => {
    test('As a product on dot.li, I get my product account', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'accounts-provider-product');
    });

    test('As a product on dot.li, I get a signer for my product account', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'accounts-provider-product-signer');
    });

    test('As a product on dot.li, I follow my account connection status', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'accounts-provider-connection-status');
    });

    test('As a product on dot.li, I get the alias of my product account', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'accounts-provider-alias');
    });
  });

  test.describe('Auth', () => {
    test("As a product on dot.li, I read the paired user's identity once the topbar shows it and the user allows it", async ({
      pairedPage,
      productFrame,
    }) => {
      // Given the topbar shows the paired user
      test.setTimeout(120_000);
      const badge = pairedPage.getByTestId('user-badge');
      await expect(badge).toBeVisible({ timeout: 30_000 });
      await expect(badge).not.toHaveText('??', { timeout: 60_000 });

      // When the user allows the disclosure for this request only, so no grant outlives the test
      const status = await runWebSignedTest(pairedPage, productFrame, 'get-user-id', [IDENTITY_ONCE], {
        timeoutMs: 20_000,
      });

      // Then
      expect(status).toBe('success');
    });

    test('As a product on dot.li, I ask the signed-in user to log in and learn they already are', async ({
      productFrame,
    }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'request-login');
    });
  });

  test.describe('Theme', () => {
    test('As a product on dot.li, I follow the host theme', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'theme-subscribe');
    });
  });

  test.describe('Entropy', () => {
    test("As a product on dot.li, I derive entropy from the user's key", async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'derive-entropy');
    });
  });

  // The host asks the user to confirm every allocation, so each test answers its own dialog.

  test.describe('Allowances', () => {
    test('As a product on dot.li, I get a statement store allowance once the user allows it', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'allowances-statement-store', [ALLOCATION], {
        timeoutMs: 90_000,
      });

      // Then
      expect(status).toBe('success');
    });

    test('As a product on dot.li, I get a Bulletin allowance once the user allows it', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'allowances-bulletin', [ALLOCATION], {
        timeoutMs: 90_000,
      });

      // Then
      expect(status).toBe('success');
    });

    test('As a product on dot.li, I get a smart contract allowance once the user allows it', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'allowances-smart-contract', [ALLOCATION], {
        timeoutMs: 90_000,
      });

      // Then
      expect(status).toBe('success');
    });

    test('As a product on dot.li, I get every allowance in one request once the user allows it', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'allowances-all', [ALLOCATION], {
        timeoutMs: 90_000,
      });

      // Then
      expect(status).toBe('success');
    });
  });

  test.describe('Storage', () => {
    test('As a product on dot.li, I write a string to my storage and read it back', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'storage-string-write-read');
    });

    test('As a product on dot.li, I clear my storage', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'storage-clear');
    });

    test('As a product on dot.li, I write bytes to my storage and read them back', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'storage-bytes-write-read');
    });

    test('As a product on dot.li, I write JSON to my storage and read it back', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'storage-json-write-read');
    });

    test('As a product on dot.li, I write and read through a storage made by the factory', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'storage-factory');
    });
  });

  // Each permission test spends its own once grant, so it leaves nothing for the tests after it.

  test.describe('Permissions', () => {
    test('As a product on dot.li, I reach a remote over HTTP and WebSocket, which the host grants without asking', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'remote-permission-remote', [], {
        timeoutMs: 30_000,
      });

      // Then
      expect(status).toBe('success');
    });

    test('As a product on dot.li, I submit to a remote chain once the user allows it, and my next broadcast spends the grant', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given the user allows the request once
      test.setTimeout(90_000);
      const granted = await runWebSignedTest(
        pairedPage,
        productFrame,
        'remote-permission-chain-submit',
        [PERMISSION_ONCE],
        { timeoutMs: 30_000 },
      );

      // When the product broadcasts, which spends the grant without asking again
      const spent = await runWebSignedTest(pairedPage, productFrame, 'chain-transaction-broadcast', [], {
        timeoutMs: 20_000,
      });

      // Then
      expect([granted, spent]).toEqual(['success', 'success']);
    });

    test('As a product on dot.li, I check that the host supports my chain', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'feature-check');
    });

    test('As a product on dot.li, I open a WebRTC connection, which the host grants without asking', async ({
      pairedPage,
      productFrame,
    }) => {
      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'remote-permission-webrtc', [], {
        timeoutMs: 30_000,
      });

      // Then
      expect(status).toBe('success');
    });

    test('As a product on dot.li, I get permission to submit a preimage once the user allows it, and my next preimage spends the grant', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given the user allows the request once
      test.setTimeout(90_000);
      const granted = await runWebSignedTest(
        pairedPage,
        productFrame,
        'remote-permission-preimage-submit',
        [PERMISSION_ONCE],
        { timeoutMs: 30_000 },
      );

      // When the product submits a preimage made by the factory, which spends the grant without asking again
      const spent = await runWebSignedTest(pairedPage, productFrame, 'preimage-factory', [], { timeoutMs: 30_000 });

      // Then
      expect([granted, spent]).toEqual(['success', 'success']);
    });

    test('As a product on dot.li, I get permission to submit a statement once the user allows it, and my next statement spends the grant', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given the user allows the request once
      test.setTimeout(150_000);
      const granted = await runWebSignedTest(
        pairedPage,
        productFrame,
        'remote-permission-statement-submit',
        [PERMISSION_ONCE],
        { timeoutMs: 30_000 },
      );

      // When the product submits a statement, which spends the grant without asking again
      const spent = await runWebSignedTest(pairedPage, productFrame, 'statement-store-submit', [], {
        timeoutMs: 90_000,
      });

      // Then
      expect([granted, spent]).toEqual(['success', 'success']);
    });
  });

  test.describe('Statements', () => {
    test('As a product user, I submit a statement once the user allows it', async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'statement-store-submit', [PERMISSION_ONCE], {
        timeoutMs: 90_000,
      });

      // Then
      expect(status).toBe('success');
    });

    test('As a product on dot.li, I create a statement proof', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'statement-store-create-proof');
    });

    test('As a product on dot.li, I create an authorized statement proof', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'statement-store-create-proof-authorized');
    });

    test('As a product on dot.li, I subscribe to statements that match all of my topics', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'statement-store-subscribe-match-all');
    });

    test('As a product on dot.li, I subscribe to statements that match any of my topics', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'statement-store-subscribe-match-any');
    });
  });

  test.describe('Navigation', () => {
    test('As a product on dot.li, I open a polkadot URL and the tab hands over to that product', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given: navigate-polkadot opens https://truapi-playground.paseo, a
      // dotNS product. dot.li hands the tab over to that product, so the
      // playground (and its result log) is gone once the call succeeds.
      const run = productFrame.locator('[data-testid="run-navigate-polkadot"]');
      await expect(run).toBeEnabled({ timeout: 10_000 });

      // When
      await run.click();

      // Then
      await pairedPage.waitForURL(url => url.origin === productOrigin('truapi-playground'), { timeout: 15_000 });

      // The worker shares the page, so the following tests need host-playground back.
      await openHostPlayground(pairedPage);
    });

    test('As a product on dot.li, I navigate my own frame to another of my pages', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given: the playground replaces its own page, so its result log goes with it
      const run = productFrame.locator('[data-testid="run-navigate-internal"]');
      await expect(run).toBeEnabled({ timeout: 10_000 });

      // When
      await run.click();

      // Then
      await expect.poll(() => new URL(productFrame.url()).pathname, { timeout: 10_000 }).toContain('/navigation');

      // The worker shares the page, so the following tests need host-playground back.
      await openHostPlayground(pairedPage);
    });

    test('As a product on dot.li, I open an http URL', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'navigate-http');
    });
  });

  test.describe('Chain', () => {
    test('As a product on dot.li, I query an account balance on chain', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'chain-query-balance');
    });

    test("As a product on dot.li, I read my chain's genesis hash", async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'chain-spec-genesis-hash');
    });

    test("As a product on dot.li, I read my chain's name", async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'chain-spec-chain-name');
    });

    test("As a product on dot.li, I read my chain's properties", async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'chain-spec-properties');
    });

    test('As a product on dot.li, I list the well-known chains', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'well-known-chains');
    });

    test('As a product on dot.li, I stop a broadcast once the user allows the submission', async ({
      pairedPage,
      productFrame,
    }) => {
      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'chain-transaction-stop', [PERMISSION_ONCE], {
        timeoutMs: 30_000,
      });

      // Then
      expect(status).toBe('success');
    });
  });

  test.describe('Contract reads', () => {
    test("As a product on dot.li, I read a contract's stored value", async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'contract-query-stored-value');
    });

    test("As a product on dot.li, I read the length of a contract's data", async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'contract-query-data-length');
    });

    test("As a product on dot.li, I read a contract's balance", async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'contract-query-balance');
    });

    test("As a product on dot.li, I read a contract's total deposits", async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'contract-query-total-deposits');
    });
  });

  test.describe('Preimage', () => {
    test('As a product on dot.li, I submit a preimage once the user allows it', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(180_000);

      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'preimage-submit', [PERMISSION_ONCE], {
        timeoutMs: 60_000,
      });

      // Then
      expect(status).toBe('success');
    });

    test('As a product on dot.li, I look up a preimage', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'preimage-lookup');
    });
  });

  test.describe('Bulletin', () => {
    test('As a product on dot.li, I upload a file to Bulletin and fetch it back by CID once the user allows the allowance and the upload', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(180_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'bulletin-upload-and-verify',
        [ALLOCATION, PERMISSION_ONCE],
        { timeoutMs: 120_000 },
      );

      // Then
      expect(status).toBe('success');
    });
  });

  test.describe('Payment', () => {
    test('As a product on dot.li, I subscribe to my balance', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'payment-balance-subscribe');
    });
  });

  test.describe('Notifications', () => {
    test('As a product user, I can allow and receive a push notification', async ({ pairedPage, productFrame }) => {
      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'push-notification', [PERMISSION_ONCE], {
        timeoutMs: 20_000,
      });

      // Then
      expect(status).toBe('success');
    });
  });

  // After the read-only tests, so a signing failure's fixture restart doesn't affect them.

  test.describe('Signing', () => {
    test('As a product on dot.li, I get a raw message signed once the user allows and signs it', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(180_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'wallet-sign-message',
        // The wallet connects first, which asks to disclose the identity and to submit, then the user signs.
        [IDENTITY_ONCE, PERMISSION_ONCE, SIGN_MESSAGE],
        { timeoutMs: 120_000 },
      );

      // Then
      expect(status).toBe('success');
    });

    test('As a product on dot.li, I create a signed transaction once the user allows and signs it', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(180_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'create-transaction',
        [PERMISSION_ONCE, SIGN_TRANSACTION],
        { timeoutMs: 120_000 },
      );

      // Then
      expect(status).toBe('success');
    });

    test('As a product on dot.li, I pay for a batch of contract writes from my smart contract allowance once the user allows and signs it', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given the product holds a smart contract allowance
      test.setTimeout(240_000);
      const granted = await runWebSignedTest(pairedPage, productFrame, 'allowances-smart-contract', [ALLOCATION], {
        timeoutMs: 90_000,
      });

      // When
      const written = await runWebSignedTest(
        pairedPage,
        productFrame,
        'sign-batch-payload',
        [PERMISSION_ONCE, SIGN_TRANSACTION, PERMISSION_ONCE],
        { timeoutMs: 120_000 },
      );

      // Then
      expect([granted, written]).toEqual(['success', 'success']);
    });
  });

  test.describe('Funded operations', () => {
    test('As a product on dot.li, I pay for storing a value in a contract from my smart contract allowance once the user allows and signs it', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given the product holds a smart contract allowance
      test.setTimeout(240_000);
      const granted = await runWebSignedTest(pairedPage, productFrame, 'allowances-smart-contract', [ALLOCATION], {
        timeoutMs: 90_000,
      });

      // When
      const stored = await runWebSignedTest(
        pairedPage,
        productFrame,
        'contract-store-value',
        [PERMISSION_ONCE, SIGN_TRANSACTION, PERMISSION_ONCE],
        { timeoutMs: 120_000 },
      );

      // Then
      expect([granted, stored]).toEqual(['success', 'success']);
    });

    test.fixme(
      'As a product on dot.li, I deposit into a payable contract and withdraw it again once the user signs both',
      {
        annotation: {
          type: 'blocked',
          description:
            'deposit() carries 0.1 PAS of native value, and the paired account is new on every run and holds none. ' +
            'Needs a funded paseo-next-v2 Asset Hub account, or a faucet without a captcha, for globalSetup to fund ' +
            'the product account from.',
        },
      },
      async ({ pairedPage, productFrame }) => {
        // Given
        test.setTimeout(300_000);
        // Unchecked while blocked: an allowance dialog may come first while the account holds no PGAS.
        const dialogs = [PERMISSION_ONCE, SIGN_TRANSACTION];

        // When: withdraw only becomes deterministic after this run's own deposit
        const deposited = await runWebSignedTest(pairedPage, productFrame, 'contract-deposit', dialogs, {
          timeoutMs: 120_000,
        });
        const withdrawn = await runWebSignedTest(pairedPage, productFrame, 'contract-withdraw', dialogs, {
          timeoutMs: 120_000,
        });

        // Then
        expect([deposited, withdrawn]).toEqual(['success', 'success']);
      },
    );
  });

  // The browser's own prompt is the consent to a device it asks for, so the host answers at once and the frame already
  // allows it. The other browser-gated devices take the same path with another directive.

  test.describe('Device permissions', () => {
    test('As a product on dot.li, I ask for the camera and get it with no host dialog, in a frame that already allows it', async ({
      productFrame,
    }) => {
      // Given
      const iframe = await productFrame.frameElement();

      // When
      await runTestExpectSuccess(productFrame, 'device-permission-camera');

      // Then
      expect(await iframe.getAttribute('allow')).toContain('camera');
    });

    for (const device of ['microphone', 'location', 'bluetooth', 'clipboard', 'open-url', 'biometrics']) {
      test(`As a product on dot.li, I ask for ${device} and get it with no host dialog`, async ({ productFrame }) => {
        // When / Then
        await runTestExpectSuccess(productFrame, `device-permission-${device}`);
      });
    }

    test('As a product on dot.li, I get notifications once the user allows them', async ({
      pairedPage,
      productFrame,
    }) => {
      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'device-permission-notifications',
        [PERMISSION_ONCE],
        {
          timeoutMs: 20_000,
        },
      );

      // Then
      expect(status).toBe('success');
    });

    test('As a product on dot.li, I ask for NFC, whose browser API cannot run in a frame, and am denied', async ({
      productFrame,
    }) => {
      // When
      const result = await runTest(productFrame, 'device-permission-nfc');

      // Then the playground reports the denial as its error
      expect(result.text).toContain('NFC permission: denied');
    });
  });
});
