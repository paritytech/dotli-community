// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect, openHostPlayground, waitForHostPlaygroundFrame } from './fixtures/paired.js';
import { runTestExpectSuccess } from './helpers/runTest.js';
import { answerHostDialogs, runWebSignedTest, type HostDialog } from './helpers/signing.js';

// Not `describe.serial`, which would skip every test after the first failure. A failure costs a fresh worker instead.

// The host dialogs these tests expect, by the title the host draws. A once answer leaves no grant behind the test.
const PERMISSION_ONCE: HostDialog = { title: 'Permission Request', answer: 'Allow once' };
const PERMISSION_ALLOW: HostDialog = { title: 'Permission Request', answer: 'Allow' };
const IDENTITY_ONCE: HostDialog = { title: 'Identity Disclosure', answer: 'Allow once' };
const ALLOCATION: HostDialog = { title: 'Resource Allocation', answer: 'Allow' };
const SIGN_MESSAGE: HostDialog = { title: 'Sign Message', answer: 'Sign' };
const SIGN_TRANSACTION: HostDialog = { title: 'Sign Transaction', answer: 'Sign' };

test.describe('dot.li > host-playground.dot', () => {
  test.describe('Accounts', () => {
    test('As a product on dot.li, I get my product account', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'accounts-provider-product');
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
      await pairedPage.waitForURL(/^http:\/\/truapi-playground\.localhost:\d+\//, { timeout: 15_000 });

      // The worker shares the page, so the following tests need host-playground back.
      await openHostPlayground(pairedPage);
    });
  });

  test.describe('Chain', () => {
    test('As a product on dot.li, I query an account balance on chain', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'chain-query-balance');
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
  });

  test.describe('Funded operations', () => {
    test.fixme(
      'As a product on dot.li, I store a value in a contract once the user signs it',
      {
        annotation: {
          type: 'blocked',
          description:
            'The product reports Invalid Payment: the truapi-host CLI signer account cannot pay the fee on ' +
            'paseo-next-v2, and its smart contract allowance does not cover it. Needs a funded account, or ' +
            'host-playground paying the fee another way.',
        },
      },
      async ({ pairedPage, productFrame }) => {
        // Given
        test.setTimeout(180_000);

        // When
        const status = await runWebSignedTest(
          pairedPage,
          productFrame,
          'contract-store-value',
          // Unchecked while blocked: a Resource Allocation dialog may come first while the account holds no PGAS.
          [PERMISSION_ONCE, SIGN_TRANSACTION],
          { timeoutMs: 120_000 },
        );

        // Then
        expect(status).toBe('success');
      },
    );

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
        // Unchecked while blocked: a Resource Allocation dialog may come first while the account holds no PGAS.
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

  // The host asks with its own dialog, then rebuilds the frame with the new `allow` once the answer reached the product.
  // The other device permissions take the same path with another directive, which the permissions spec maps.

  test.describe('Device permissions', () => {
    test('As a product on dot.li, I get the camera once the user allows it, in a frame rebuilt with camera access', async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(120_000);
      const run = productFrame.locator('[data-testid="run-device-permission-camera"]');
      await expect(run).toBeEnabled({ timeout: 15_000 });

      // When the user allows the host's dialog, whose grant rebuilds the frame
      await run.click();
      await answerHostDialogs(pairedPage, [PERMISSION_ALLOW]);
      const rebuilt = await waitForHostPlaygroundFrame(pairedPage, 60_000, productFrame);

      // Then
      const iframe = await rebuilt.frameElement();
      expect(await iframe.getAttribute('allow')).toContain('camera');
      // The rebuilt product reconnects to the core before its run button comes back, and runTest allows that only 5 s.
      await expect(rebuilt.locator('[data-testid="run-device-permission-camera"]')).toBeEnabled({ timeout: 15_000 });
      // The grant is stored, so asking again is answered with no dialog and no rebuild.
      await runTestExpectSuccess(rebuilt, 'device-permission-camera');
    });
  });
});
