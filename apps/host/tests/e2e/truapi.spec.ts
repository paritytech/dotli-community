// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect, openHostPlayground, waitForHostPlaygroundFrame } from './fixtures/paired.js';
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

    test('As a product on dot.li, I get my product account alias', async ({ productFrame }) => {
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

    test.fixme(
      'As a product on dot.li, I get every allowance at once once the user allows them',
      {
        annotation: {
          type: 'blocked',
          description:
            "host-playground's allowances-all has no timeoutMs, so the product gives up at its 30 s default while " +
            'three allocations go through the signer. Needs timeoutMs: 90_000 in its lib/tests/allowances.ts.',
        },
      },
      async ({ pairedPage, productFrame }) => {
        // Given
        test.setTimeout(120_000);

        // When
        const status = await runWebSignedTest(pairedPage, productFrame, 'allowances-all', ['Always allow', 'Allow'], {
          timeoutMs: 90_000,
        });

        // Then
        expect(status).toBe('success');
      },
    );
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

    test('As a product user, I can navigate within the current product', async ({ productFrame }) => {
      // Given
      const button = productFrame.locator('[data-testid="run-navigate-internal"]');
      await expect(button).toBeVisible();

      // When
      await button.click();

      // Then
      await expect.poll(() => productFrame.url()).toMatch(/\/navigation\/?\?id=hello#fragment=something$/);
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

    // The product broadcasts a transaction the chain rejects, so these need no funds, only an operation id.
    test('As a product on dot.li, I broadcast a chain transaction and get an operation id', async ({
      productFrame,
    }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'chain-transaction-broadcast');
    });

    test('As a product on dot.li, I stop a chain transaction I broadcast', async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, 'chain-transaction-stop');
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

    test('As a product on dot.li, I create a signed transaction once the user signs it', async ({
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
        ['Always allow', 'Allow', 'Sign'],
        { timeoutMs: 120_000 },
      );

      // Then
      expect(status).toBe('success');
    });

    test.fixme(
      'As a product on dot.li, I submit a batch of two contract writes once the user signs it',
      {
        annotation: {
          type: 'blocked',
          description:
            "host-playground's sign-batch-payload has no timeoutMs, so the product gives up at its 30 s default " +
            'before the batch is final. Needs timeoutMs: 90_000 in its lib/tests/signing.ts.',
        },
      },
      async ({ pairedPage, productFrame }) => {
        // Given
        test.setTimeout(180_000);

        // When
        const status = await runWebSignedTest(
          pairedPage,
          productFrame,
          'sign-batch-payload',
          ['Always allow', 'Allow', 'Sign'],
          { timeoutMs: 120_000 },
        );

        // Then
        expect(status).toBe('success');
      },
    );
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
          ['Always allow', 'Allow', 'Sign'],
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
        const dialogs = ['Always allow', 'Allow', 'Sign'];

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

      // When: the fixture's auto-allow answers the host's dialog, and the grant rebuilds the frame
      await run.click();
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
