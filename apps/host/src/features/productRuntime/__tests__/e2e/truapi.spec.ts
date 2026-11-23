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
// A contract write from a product that holds a smart contract allowance.
const CONTRACT_WRITE: readonly HostDialog[] = [PERMISSION_ONCE, SIGN_TRANSACTION, PERMISSION_ONCE];

/** One test per row whose product call needs no host dialog, titled by the action the row names. */
function testsWithoutDialogs(rows: readonly (readonly [action: string, testId: string])[]): void {
  for (const [action, testId] of rows) {
    test(`As a product on dot.li, ${action}`, async ({ productFrame }) => {
      // When / Then
      await runTestExpectSuccess(productFrame, testId);
    });
  }
}

test.describe('dot.li > host-playground.dot', () => {
  test.describe('Accounts', () => {
    testsWithoutDialogs([
      ['I get my product account', 'accounts-provider-product'],
      ['I get a signer for my product account', 'accounts-provider-product-signer'],
      ['I follow my account connection status', 'accounts-provider-connection-status'],
      ['I get the alias of my product account', 'accounts-provider-alias'],
    ]);
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

    testsWithoutDialogs([['I request a login from the signed-in user and learn they are logged in', 'request-login']]);
  });

  test.describe('Theme', () => {
    testsWithoutDialogs([['I follow the host theme', 'theme-subscribe']]);
  });

  test.describe('Entropy', () => {
    testsWithoutDialogs([["I derive entropy from the user's key", 'derive-entropy']]);
  });

  // The host asks the user to confirm every allocation, so each test answers its own dialog.

  test.describe('Allowances', () => {
    for (const [allowance, testId] of [
      ['a statement store allowance', 'allowances-statement-store'],
      ['a Bulletin allowance', 'allowances-bulletin'],
      ['a smart contract allowance', 'allowances-smart-contract'],
      ['every allowance in one request', 'allowances-all'],
    ] as const) {
      test(`As a product on dot.li, I get ${allowance} once the user allows it`, async ({
        pairedPage,
        productFrame,
      }) => {
        // Given
        test.setTimeout(120_000);

        // When
        const status = await runWebSignedTest(pairedPage, productFrame, testId, [ALLOCATION], { timeoutMs: 90_000 });

        // Then
        expect(status).toBe('success');
      });
    }
  });

  test.describe('Storage', () => {
    testsWithoutDialogs([
      ['I write a string to my storage and read it back', 'storage-string-write-read'],
      ['I clear my storage', 'storage-clear'],
      ['I write bytes to my storage and read them back', 'storage-bytes-write-read'],
      ['I write JSON to my storage and read it back', 'storage-json-write-read'],
      ['I write and read through a storage made by the factory', 'storage-factory'],
    ]);
  });

  // Each permission test spends its own once grant, so it leaves nothing for the tests after it.

  test.describe('Permissions', () => {
    for (const [remote, testId] of [
      ['reach a remote over HTTP and WebSocket', 'remote-permission-remote'],
      ['open a WebRTC connection', 'remote-permission-webrtc'],
    ] as const) {
      test(`As a product on dot.li, I ${remote}, which the host grants without asking`, async ({
        pairedPage,
        productFrame,
      }) => {
        // Given
        test.setTimeout(60_000);

        // When
        const status = await runWebSignedTest(pairedPage, productFrame, testId, [], { timeoutMs: 30_000 });

        // Then
        expect(status).toBe('success');
      });
    }

    for (const { action, grantId, spendId, spendTimeoutMs } of [
      {
        action: 'submit to a remote chain once the user allows it, and my next broadcast spends the grant',
        grantId: 'remote-permission-chain-submit',
        spendId: 'chain-transaction-broadcast',
        spendTimeoutMs: 20_000,
      },
      {
        action: 'get permission to submit a preimage once the user allows it, and my next preimage spends the grant',
        grantId: 'remote-permission-preimage-submit',
        spendId: 'preimage-factory',
        spendTimeoutMs: 30_000,
      },
      {
        action: 'get permission to submit a statement once the user allows it, and my next statement spends the grant',
        grantId: 'remote-permission-statement-submit',
        spendId: 'statement-store-submit',
        spendTimeoutMs: 90_000,
      },
    ]) {
      test(`As a product on dot.li, I ${action}`, async ({ pairedPage, productFrame }) => {
        // Given the user allows the request once
        test.setTimeout(150_000);
        const grantStatus = await runWebSignedTest(pairedPage, productFrame, grantId, [PERMISSION_ONCE], {
          timeoutMs: 30_000,
        });

        // When the product's next request of that kind spends the grant without asking again
        const spendStatus = await runWebSignedTest(pairedPage, productFrame, spendId, [], {
          timeoutMs: spendTimeoutMs,
        });

        // Then
        expect([grantStatus, spendStatus]).toEqual(['success', 'success']);
      });
    }

    testsWithoutDialogs([['I check that the host supports my chain', 'feature-check']]);
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

    testsWithoutDialogs([
      ['I create a statement proof', 'statement-store-create-proof'],
      ['I create an authorized statement proof', 'statement-store-create-proof-authorized'],
      ['I subscribe to statements that match all of my topics', 'statement-store-subscribe-match-all'],
      ['I subscribe to statements that match any of my topics', 'statement-store-subscribe-match-any'],
    ]);
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

    testsWithoutDialogs([['I open an http URL', 'navigate-http']]);
  });

  test.describe('Chain', () => {
    testsWithoutDialogs([
      ['I query an account balance on chain', 'chain-query-balance'],
      ["I read my chain's genesis hash", 'chain-spec-genesis-hash'],
      ["I read my chain's name", 'chain-spec-chain-name'],
      ["I read my chain's properties", 'chain-spec-properties'],
      ['I list the well-known chains', 'well-known-chains'],
    ]);

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
    testsWithoutDialogs([
      ["I read a contract's stored value", 'contract-query-stored-value'],
      ["I read the length of a contract's data", 'contract-query-data-length'],
      ["I read a contract's balance", 'contract-query-balance'],
      ["I read a contract's total deposits", 'contract-query-total-deposits'],
    ]);
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

    testsWithoutDialogs([['I look up a preimage', 'preimage-lookup']]);
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
    testsWithoutDialogs([['I subscribe to my balance', 'payment-balance-subscribe']]);
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

  test.describe('Contract writes', () => {
    for (const [write, testId] of [
      ['a batch of contract writes', 'sign-batch-payload'],
      ['storing a value in a contract', 'contract-store-value'],
    ] as const) {
      test(`As a product on dot.li, I pay for ${write} from my smart contract allowance once the user allows and signs it`, async ({
        pairedPage,
        productFrame,
      }) => {
        // Given the product holds a smart contract allowance
        test.setTimeout(240_000);
        const grantStatus = await runWebSignedTest(
          pairedPage,
          productFrame,
          'allowances-smart-contract',
          [ALLOCATION],
          {
            timeoutMs: 90_000,
          },
        );

        // When
        const writeStatus = await runWebSignedTest(pairedPage, productFrame, testId, CONTRACT_WRITE, {
          timeoutMs: 120_000,
        });

        // Then
        expect([grantStatus, writeStatus]).toEqual(['success', 'success']);
      });
    }
  });

  test.describe('Funded operations', () => {
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

    testsWithoutDialogs(
      ['microphone', 'location', 'bluetooth', 'clipboard', 'open-url', 'biometrics'].map(
        device => [`I request ${device} and get it with no host dialog`, `device-permission-${device}`] as const,
      ),
    );

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
        { timeoutMs: 20_000 },
      );

      // Then
      expect(status).toBe('success');
    });

    // dot.li denies NFC, since its browser API cannot run in a frame.
    test('As a product on dot.li, I request NFC and am denied', async ({ productFrame }) => {
      // When
      const result = await runTest(productFrame, 'device-permission-nfc');

      // Then the playground reports the denial as its error
      expect(result.text).toContain('NFC permission: denied');
    });
  });
});
