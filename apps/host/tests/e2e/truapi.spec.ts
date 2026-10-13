// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect, openHostPlayground } from './fixtures/paired.js';
import { waitForPlaygroundReady, runTestExpectSuccess } from './helpers/run-test.js';
import { runWebSignedTest } from './helpers/signing.js';

// Not `describe.serial`, which would skip every test after the first failure. A failure costs a fresh worker instead.

test.describe('dot.li > host-playground.dot', () => {
  test('As a product on dot.li, I load in the host and report ready', async ({ productFrame }) => {
    // When / Then
    await waitForPlaygroundReady(productFrame);
  });

  test.describe('Accounts', () => {
    test('As a product on dot.li, I get my product account', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'accounts-provider-product');
    });

    test('As a product on dot.li, I get a signer for my product account', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'accounts-provider-product-signer');
    });

    test('As a product on dot.li, I follow the account connection status', async ({ productFrame }) => {
      // Given
      test.setTimeout(60_000);

      // When / Then
      await runTestExpectSuccess(productFrame, 'accounts-provider-connection-status');
    });

    // The product-side alias check itself reports FAILED.
    test.fixme('As a product on dot.li, I get my product account alias', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'accounts-provider-alias');
    });
  });

  test.describe('Auth', () => {
    test('As a product on dot.li, I request a login', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'request-login');
    });

    test("As a product on dot.li, I read the paired user's identity once the topbar shows it", async ({
      pairedPage,
      productFrame,
    }) => {
      // Given the topbar shows the paired user
      test.setTimeout(120_000);
      const badge = pairedPage.getByTestId('user-badge');
      await expect(badge).toBeVisible({ timeout: 30_000 });
      await expect(badge).not.toHaveText('??', { timeout: 60_000 });

      // When / Then
      await runTestExpectSuccess(productFrame, 'get-user-id');
    });
  });

  test.describe('Theme', () => {
    test('As a product on dot.li, I subscribe to the theme', async ({ productFrame }) => {
      // Given
      test.setTimeout(15_000);

      // When / Then
      await runTestExpectSuccess(productFrame, 'theme-subscribe');
    });
  });

  test.describe('Entropy', () => {
    test('As a product on dot.li, I derive entropy', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'derive-entropy');
    });
  });

  test.describe('Connection & Providers', () => {
    test('As a product on dot.li, I list the well-known chains', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'well-known-chains');
    });
  });

  // Each allocation opens a host permission modal, which is all these tests drive.

  test.describe('Allowances', () => {
    test('As a product on dot.li, I get a statement store allowance once the user allows it', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'allowances-statement-store',
        ['Always allow', 'Allow'],
        { timeoutMs: 90_000 },
      );

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
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'allowances-bulletin',
        ['Always allow', 'Allow'],
        { timeoutMs: 90_000 },
      );

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
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'allowances-smart-contract',
        ['Always allow', 'Allow'],
        { timeoutMs: 90_000 },
      );

      // Then
      expect(status).toBe('success');
    });

    // The combined allocation times out at 30s while the individual ones pass.
    test.fixme('As a product on dot.li, I get every allowance at once once the user allows them', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'allowances-all', ['Always allow', 'Allow'], {
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

    test('As a product on dot.li, I write bytes to my storage and read them back', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'storage-bytes-write-read');
    });

    test('As a product on dot.li, I write JSON to my storage and read it back', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'storage-json-write-read');
    });

    test('As a product on dot.li, I clear my storage', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'storage-clear');
    });

    test('As a product on dot.li, I use a storage factory', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'storage-factory');
    });
  });

  // The first request for a capability in a session opens a host permission modal.

  test.describe('Permissions', () => {
    test('As a product on dot.li, I check which features the host supports', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'feature-check');
    });

    test('As a product on dot.li, I reach a remote over HTTP and WebSocket once the user allows it', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'remote-permission-remote',
        ['Always allow', 'Allow'],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe('success');
    });

    test('As a product on dot.li, I reach a remote over WebRTC once the user allows it', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'remote-permission-webrtc',
        ['Always allow', 'Allow'],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe('success');
    });

    test('As a product on dot.li, I submit to a remote chain once the user allows it', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'remote-permission-chain-submit',
        ['Always allow', 'Allow'],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe('success');
    });

    test('As a product on dot.li, I submit a preimage remotely once the user allows it', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'remote-permission-preimage-submit',
        ['Always allow', 'Allow'],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe('success');
    });

    test('As a product on dot.li, I submit a statement remotely once the user allows it', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'remote-permission-statement-submit',
        ['Always allow', 'Allow'],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe('success');
    });
  });

  test.describe('Statements', () => {
    test('As a product user, I can create an authorized statement proof', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'statement-store-create-proof-authorized');
    });

    test('As a product user, I can submit a statement', async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'statement-store-submit',
        ['Always allow', 'Allow'],
        { timeoutMs: 90_000 },
      );

      // Then
      expect(status).toBe('success');
    });

    test('As a product on dot.li, I subscribe to statements matching all topics', async ({ productFrame }) => {
      // Given
      test.setTimeout(60_000);

      // When / Then
      await runTestExpectSuccess(productFrame, 'statement-store-subscribe-match-all');
    });

    test('As a product on dot.li, I subscribe to statements matching any topic', async ({ productFrame }) => {
      // Given
      test.setTimeout(60_000);

      // When / Then
      await runTestExpectSuccess(productFrame, 'statement-store-subscribe-match-any');
    });
  });

  test.describe('Navigation', () => {
    test('As a product on dot.li, I open an HTTP URL', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'navigate-http');
    });

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
      await pairedPage.waitForURL(/^http:\/\/truapi-playground\.localhost:\d+\//, { timeout: 15_000 });

      // The worker shares the page, so the following tests need host-playground back.
      await openHostPlayground(pairedPage);
    });

    // The iframe lands on /navigation?id= while the assertion expects /page?id=.
    test.fixme('As a product user, I can navigate within the current product', async ({ productFrame }) => {
      // Given
      const button = productFrame.locator('[data-testid="run-navigate-internal"]');
      await expect(button).toBeVisible();

      // When
      await button.click();

      // Then
      await expect.poll(() => productFrame.url()).toContain('/page?id=hello#fragment=something');
      await productFrame.getByRole('link', { name: 'Back to tests' }).click();
      await waitForPlaygroundReady(productFrame);
    });
  });

  test.describe('Chain', () => {
    test("As a product on dot.li, I read a chain's genesis hash", async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'chain-spec-genesis-hash');
    });

    test("As a product on dot.li, I read a chain's name", async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'chain-spec-chain-name');
    });

    test("As a product on dot.li, I read a chain's properties", async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'chain-spec-properties');
    });

    test('As a product on dot.li, I query an account balance on chain', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'chain-query-balance');
    });
  });

  test.describe('Contract (read-only)', () => {
    test("As a product on dot.li, I query a contract's stored value", async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'contract-query-stored-value');
    });

    test("As a product on dot.li, I query a contract's data length", async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'contract-query-data-length');
    });

    test("As a product on dot.li, I query a contract's balance", async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'contract-query-balance');
    });

    test("As a product on dot.li, I query a contract's total deposits", async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'contract-query-total-deposits');
    });
  });

  test.describe('Preimage', () => {
    test('As a product on dot.li, I look up a preimage', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'preimage-lookup');
    });

    test('As a product on dot.li, I create a preimage through its factory once the user allows it', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(180_000);

      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'preimage-factory', ['Always allow', 'Allow'], {
        timeoutMs: 60_000,
      });

      // Then
      expect(status).toBe('success');
    });

    test('As a product on dot.li, I submit a preimage once the user allows it', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(180_000);

      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'preimage-submit', ['Always allow', 'Allow'], {
        timeoutMs: 60_000,
      });

      // Then
      expect(status).toBe('success');
    });
  });

  test.describe('Notifications', () => {
    test('As a product user, I can allow and receive a push notification', async ({ pairedPage, productFrame }) => {
      // Given
      const approvalButtons = ['Always allow', 'Allow'];

      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'push-notification', approvalButtons, {
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
        ['Always allow', 'Allow', 'Sign'],
        { timeoutMs: 120_000, preClickDelayMs: 1_000 },
      );

      // Then
      expect(status).toBe('success');
    });
  });

  // Skipped until the fixture funds its account from a faucet.
  test.describe('Funded operations', () => {
    test.skip('As a product on dot.li, I get a batch payload signed', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'sign-batch-payload');
    });
    test.skip('As a product on dot.li, I create a transaction', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'create-transaction');
    });
    test.skip('As a product on dot.li, I store a value in a contract', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'contract-store-value');
    });
    test.skip('As a product on dot.li, I deposit into a payable contract', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'contract-deposit');
    });
    test.skip('As a product on dot.li, I withdraw from a contract', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'contract-withdraw');
    });
    test.skip('As a product on dot.li, I broadcast a chain transaction', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'chain-transaction-broadcast');
    });
    test.skip('As a product on dot.li, I stop broadcasting a chain transaction', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'chain-transaction-stop');
    });
    test.skip('As a product on dot.li, I subscribe to a payment balance', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'payment-balance-subscribe');
    });
  });

  // Native mobile prompts with no headless Chromium equivalent, listed for parity with host-playground.

  test.describe('Device permissions', () => {
    test.skip('As a product on dot.li, I ask for the camera', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'device-permission-camera');
    });
    test.skip('As a product on dot.li, I ask for the microphone', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'device-permission-microphone');
    });
    test.skip('As a product on dot.li, I ask for Bluetooth', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'device-permission-bluetooth');
    });
    test.skip('As a product on dot.li, I ask for biometrics', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'device-permission-biometrics');
    });
    test.skip('As a product on dot.li, I ask for the clipboard', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'device-permission-clipboard');
    });
    test.skip('As a product on dot.li, I ask for the location', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'device-permission-location');
    });
    test.skip('As a product on dot.li, I ask for NFC', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'device-permission-nfc');
    });
    test.skip('As a product on dot.li, I ask to send notifications', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'device-permission-notifications');
    });
    test.skip('As a product on dot.li, I ask to open a URL', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'device-permission-open-url');
    });
  });
});
