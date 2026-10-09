// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect, openHostPlayground } from './fixtures/paired.js';
import { waitForPlaygroundReady, runTestExpectSuccess } from './helpers/run-test.js';
import { runWebSignedTest, type HostDialogDecision } from './helpers/signing.js';

// Not `describe.serial`, which would skip every test after the first failure. A failure costs a fresh worker instead.

// Core permission decisions and signing/resource reviews have separate authority.
const lastingPermission: HostDialogDecision = { title: 'Permission Request', button: 'Always allow' };
const resourceAllocation: HostDialogDecision = { title: 'Resource Allocation', button: 'Allow' };
const preimageDecisions: readonly HostDialogDecision[] = [
  lastingPermission,
  resourceAllocation,
  { title: 'Submit Preimage', button: 'Allow once' },
];

test.describe('dot.li > host-playground.dot', () => {
  test('Product is ready', async ({ productFrame }) => {
    await waitForPlaygroundReady(productFrame);
  });

  test.describe('Accounts', () => {
    test('Get Product Account', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'accounts-provider-product');
    });

    test('Product Signer', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'accounts-provider-product-signer');
    });

    test('Account Connection Status', async ({ productFrame }) => {
      test.setTimeout(60_000);
      await runTestExpectSuccess(productFrame, 'accounts-provider-connection-status');
    });

    // The product-side alias check itself reports FAILED.
    test.fixme('Product Account Alias', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'accounts-provider-alias');
    });
  });

  test.describe('Auth', () => {
    test('Request Login', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'request-login');
    });

    test('Get User Identity', async ({ pairedPage, productFrame }) => {
      test.setTimeout(120_000);
      const badge = pairedPage.getByTestId('user-badge');
      await expect(badge).toBeVisible({ timeout: 30_000 });
      await expect(badge).not.toHaveText('??', { timeout: 60_000 });
      expect(
        await runWebSignedTest(pairedPage, productFrame, 'get-user-id', [
          { title: 'Identity Disclosure', button: 'Always allow' },
        ]),
      ).toBe('success');
    });
  });

  test.describe('Theme', () => {
    test('Subscribe Theme', async ({ productFrame }) => {
      test.setTimeout(15_000);
      await runTestExpectSuccess(productFrame, 'theme-subscribe');
    });
  });

  test.describe('Entropy', () => {
    test('Derive Entropy', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'derive-entropy');
    });
  });

  test.describe('Connection & Providers', () => {
    test('Well-Known Chains', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'well-known-chains');
    });
  });

  // Each allocation opens a host permission modal, which is all these tests drive.

  test.describe('Allowances', () => {
    test('StatementStore Allowance', async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'allowances-statement-store',
        [resourceAllocation],
        { timeoutMs: 90_000 },
      );

      // Then
      expect(status).toBe('success');
    });

    test('Bulletin Allowance', async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'allowances-bulletin', [resourceAllocation], {
        timeoutMs: 90_000,
      });

      // Then
      expect(status).toBe('success');
    });

    test('Smart-Contract Allowance', async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'allowances-smart-contract',
        [resourceAllocation],
        { timeoutMs: 90_000 },
      );

      // Then
      expect(status).toBe('success');
    });

    // The combined allocation times out at 30s while the individual ones pass.
    test.fixme('All Allowances', async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'allowances-all', [resourceAllocation], {
        timeoutMs: 90_000,
      });

      // Then
      expect(status).toBe('success');
    });
  });

  test.describe('Storage', () => {
    test('String Write & Read', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'storage-string-write-read');
    });

    test('Bytes Write & Read', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'storage-bytes-write-read');
    });

    test('JSON Write & Read', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'storage-json-write-read');
    });

    test('Clear', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'storage-clear');
    });

    test('Factory', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'storage-factory');
    });
  });

  // The first request for a capability in a session opens a host permission modal.

  test.describe('Permissions', () => {
    test('Feature Check', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'feature-check');
    });

    test('Remote: HTTP/WS', async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'remote-permission-remote', [], {
        timeoutMs: 30_000,
      });

      // Then
      expect(status).toBe('success');
    });

    test('Remote: WebRTC', async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'remote-permission-webrtc', [], {
        timeoutMs: 30_000,
      });

      // Then
      expect(status).toBe('success');
    });

    test('Remote: Chain Submit', async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'remote-permission-chain-submit',
        [lastingPermission],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe('success');
    });

    test('Remote: Preimage Submit', async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'remote-permission-preimage-submit',
        [lastingPermission],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe('success');
    });

    test('Remote: Statement Submit', async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'remote-permission-statement-submit',
        [lastingPermission],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe('success');
    });
  });

  test.describe('Statements', () => {
    test('As a product user, I can create an authorized statement proof', async ({ pairedPage, productFrame }) => {
      expect(
        await runWebSignedTest(pairedPage, productFrame, 'statement-store-create-proof-authorized', [
          resourceAllocation,
          { title: 'Proof Permission', button: 'Allow' },
        ]),
      ).toBe('success');
    });

    test('As a product user, I can submit a statement', async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'statement-store-submit',
        [lastingPermission, resourceAllocation, { title: 'Sign Statement', button: 'Sign' }],
        { timeoutMs: 90_000 },
      );

      // Then
      expect(status).toBe('success');
    });

    test('Subscribe Match All', async ({ productFrame }) => {
      test.setTimeout(60_000);
      await runTestExpectSuccess(productFrame, 'statement-store-subscribe-match-all');
    });

    test('Subscribe Match Any', async ({ productFrame }) => {
      test.setTimeout(60_000);
      await runTestExpectSuccess(productFrame, 'statement-store-subscribe-match-any');
    });
  });

  test.describe('Navigation', () => {
    test('HTTP URL', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'navigate-http');
    });

    test('Polkadot URL', async ({ pairedPage, productFrame }) => {
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
    test('Chain Spec: Genesis Hash', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'chain-spec-genesis-hash');
    });

    test('Chain Spec: Chain Name', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'chain-spec-chain-name');
    });

    test('Chain Spec: Properties', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'chain-spec-properties');
    });

    test('Query Balance', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'chain-query-balance');
    });
  });

  test.describe('Contract (read-only)', () => {
    test('Query Stored Value', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'contract-query-stored-value');
    });

    test('Query Data Length', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'contract-query-data-length');
    });

    test('Query Balance', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'contract-query-balance');
    });

    test('Query Total Deposits', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'contract-query-total-deposits');
    });
  });

  test.describe('Preimage', () => {
    test('Lookup', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'preimage-lookup');
    });

    test('Factory', async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(180_000);

      // When
      // Upload consent is separate from signing permission; approve this
      // operation without granting a persistent automatic-upload budget.
      const status = await runWebSignedTest(pairedPage, productFrame, 'preimage-factory', preimageDecisions, {
        timeoutMs: 60_000,
      });

      // Then
      expect(status).toBe('success');
    });

    test('Submit', async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(180_000);

      // When
      const status = await runWebSignedTest(pairedPage, productFrame, 'preimage-submit', preimageDecisions, {
        timeoutMs: 60_000,
      });

      // Then
      expect(status).toBe('success');
    });
  });

  test.describe('Notifications', () => {
    test('As a product user, I can allow and receive a push notification', async ({ pairedPage, productFrame }) => {
      // Given
      const approvalButtons = [lastingPermission];

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
    test('Sign Raw Message', async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(180_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        'wallet-sign-message',
        [{ title: 'Sign Message', button: 'Sign' }],
        { timeoutMs: 120_000, preClickDelayMs: 1_000 },
      );

      // Then
      expect(status).toBe('success');
    });
  });

  // Skipped until the fixture funds its account from a faucet.
  test.describe('Funded operations', () => {
    test.skip('Sign Batch Payload', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'sign-batch-payload');
    });
    test.skip('Create Transaction', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'create-transaction');
    });
    test.skip('Contract: Store Value', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'contract-store-value');
    });
    test.skip('Contract: Deposit (payable)', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'contract-deposit');
    });
    test.skip('Contract: Withdraw', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'contract-withdraw');
    });
    test.skip('Chain Tx: Broadcast', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'chain-transaction-broadcast');
    });
    test.skip('Chain Tx: Stop Broadcast', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'chain-transaction-stop');
    });
    test.skip('Payment: Balance Subscribe', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'payment-balance-subscribe');
    });
  });

  // Native mobile prompts with no headless Chromium equivalent, listed for parity with host-playground.

  test.describe('Device permissions', () => {
    test.skip('Camera', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'device-permission-camera');
    });
    test.skip('Microphone', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'device-permission-microphone');
    });
    test.skip('Bluetooth', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'device-permission-bluetooth');
    });
    test.skip('Biometrics', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'device-permission-biometrics');
    });
    test.skip('Clipboard', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'device-permission-clipboard');
    });
    test.skip('Location', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'device-permission-location');
    });
    test.skip('NFC', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'device-permission-nfc');
    });
    test.skip('Notifications', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'device-permission-notifications');
    });
    test.skip('Open URL', async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, 'device-permission-open-url');
    });
  });
});
