// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Page } from "@playwright/test";
import { test, expect, currentProductFrame } from "./fixtures/paired";
import {
  waitForPlaygroundReady,
  runTestExpectSuccess,
} from "./helpers/run-test";
import { runWebSignedTest } from "./helpers/signing";

// Playwright destroys the worker process after a test failure, so the
// worker-scoped pairing fixture re-pairs from scratch on every failed test
// (~10-30s extra). Acceptable trade-off, preferred over `describe.serial`
// which would skip every test after the first failure.

test.describe("dot.li > host-playground.dot", () => {
  test("Product is ready", async ({ productFrame }) => {
    await waitForPlaygroundReady(productFrame);
  });

  test.describe("Accounts", () => {
    test("Get Product Account", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "accounts-provider-product");
    });

    test("Product Signer", async ({ productFrame }) => {
      await runTestExpectSuccess(
        productFrame,
        "accounts-provider-product-signer",
      );
    });

    test("Account Connection Status", async ({ productFrame }) => {
      test.setTimeout(60_000);
      await runTestExpectSuccess(
        productFrame,
        "accounts-provider-connection-status",
      );
    });

    // Needs a People Lite ring key registered for the personhood ring owner;
    // the fresh per-run lite username has none, so the card stops early.
    test.fixme("Product Account Alias", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "accounts-provider-alias");
    });
  });

  test.describe("Auth", () => {
    test("Request Login", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "request-login");
    });

    test("Get User Identity", async ({ pairedPage, productFrame }) => {
      test.setTimeout(120_000);
      const badge = pairedPage.locator(".user-badge");
      await expect(badge).toBeVisible({ timeout: 30_000 });
      await expect(badge).not.toHaveText("??", { timeout: 60_000 });
      await runTestExpectSuccess(productFrame, "get-user-id");
    });
  });

  test.describe("Theme", () => {
    test("Subscribe Theme", async ({ productFrame }) => {
      test.setTimeout(15_000);
      await runTestExpectSuccess(productFrame, "theme-subscribe");
    });
  });

  test.describe("Entropy", () => {
    test("Derive Entropy", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "derive-entropy");
    });
  });

  test.describe("Connection & Providers", () => {
    test("Well-Known Chains", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "well-known-chains");
    });
  });

  // Each allocation triggers an "Allow" modal on the host that the user
  // approves. The signing host is paired so the test only drives the modal.

  test.describe("Allowances", () => {
    test("StatementStore Allowance", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "allowances-statement-store",
        ["Allow"],
        { timeoutMs: 90_000 },
      );

      // Then
      expect(status).toBe("success");
    });

    test("Bulletin Allowance", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "allowances-bulletin",
        ["Allow"],
        { timeoutMs: 90_000 },
      );

      // Then
      expect(status).toBe("success");
    });

    test("Smart-Contract Allowance", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "allowances-smart-contract",
        ["Allow"],
        { timeoutMs: 90_000 },
      );

      // Then
      expect(status).toBe("success");
    });

    // The CLI allocates the three resources serially (~55 s together) while
    // the card keeps host-playground's 30 s default; needs timeoutMs there.
    test.fixme("All Allowances", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "allowances-all",
        ["Allow"],
        { timeoutMs: 90_000 },
      );

      // Then
      expect(status).toBe("success");
    });
  });

  test.describe("Storage", () => {
    test("String Write & Read", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "storage-string-write-read");
    });

    test("Bytes Write & Read", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "storage-bytes-write-read");
    });

    test("JSON Write & Read", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "storage-json-write-read");
    });

    test("Clear", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "storage-clear");
    });

    test("Factory", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "storage-factory");
    });
  });

  // Remote-permission tests trigger an "Allow" modal on the host the
  // first time a given capability is requested in a session.

  test.describe("Permissions", () => {
    test("Feature Check", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "feature-check");
    });

    test("Remote: HTTP/WS", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "remote-permission-remote",
        ["Allow"],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe("success");
    });

    test("Remote: WebRTC", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "remote-permission-webrtc",
        ["Allow"],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe("success");
    });

    test("Remote: Chain Submit", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "remote-permission-chain-submit",
        ["Allow"],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe("success");
    });

    test("Remote: Preimage Submit", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "remote-permission-preimage-submit",
        ["Allow"],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe("success");
    });

    test("Remote: Statement Submit", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "remote-permission-statement-submit",
        ["Allow"],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe("success");
    });
  });

  test.describe("Statements", () => {
    test("As a product user, I can create an authorized statement proof", async ({
      productFrame,
    }) => {
      await runTestExpectSuccess(
        productFrame,
        "statement-store-create-proof-authorized",
      );
    });

    test("As a product user, I can submit a statement", async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "statement-store-submit",
        ["Allow"],
        { timeoutMs: 90_000 },
      );

      // Then
      expect(status).toBe("success");
    });

    test("Subscribe Match All", async ({ productFrame }) => {
      test.setTimeout(60_000);
      await runTestExpectSuccess(
        productFrame,
        "statement-store-subscribe-match-all",
      );
    });

    test("Subscribe Match Any", async ({ productFrame }) => {
      test.setTimeout(60_000);
      await runTestExpectSuccess(
        productFrame,
        "statement-store-subscribe-match-any",
      );
    });
  });

  test.describe("Navigation", () => {
    test("HTTP URL", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "navigate-http");
    });

    test("Polkadot URL", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "navigate-polkadot");
    });

    // The card pushes /navigation/ with query and fragment intact; Next may
    // drop the trailing slash, so accept either spelling.
    test("As a product user, I can navigate within the current product", async ({
      productFrame,
    }) => {
      // Given
      const button = productFrame.locator(
        '[data-testid="run-navigate-internal"]',
      );
      await expect(button).toBeVisible();

      // When
      await button.click();

      // Then
      await expect
        .poll(() => productFrame.url())
        .toMatch(/\/navigation\/?\?id=hello#fragment=something$/);
      await productFrame.getByRole("link", { name: "Back to tests" }).click();
      await waitForPlaygroundReady(productFrame);
    });
  });

  test.describe("Chain", () => {
    test("Chain Spec: Genesis Hash", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "chain-spec-genesis-hash");
    });

    test("Chain Spec: Chain Name", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "chain-spec-chain-name");
    });

    test("Chain Spec: Properties", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "chain-spec-properties");
    });

    test("Query Balance", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "chain-query-balance");
    });
  });

  test.describe("Contract (read-only)", () => {
    test("Query Stored Value", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "contract-query-stored-value");
    });

    test("Query Data Length", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "contract-query-data-length");
    });

    test("Query Balance", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "contract-query-balance");
    });

    test("Query Total Deposits", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "contract-query-total-deposits");
    });
  });

  test.describe("Preimage", () => {
    test("Lookup", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "preimage-lookup");
    });

    test("Factory", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(180_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "preimage-factory",
        ["Allow"],
        { timeoutMs: 60_000 },
      );

      // Then
      expect(status).toBe("success");
    });

    test("Submit", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(180_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "preimage-submit",
        ["Allow"],
        { timeoutMs: 60_000 },
      );

      // Then
      expect(status).toBe("success");
    });
  });

  test.describe("Notifications", () => {
    test("As a product user, I can allow and receive a push notification", async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      const approvalButtons = ["Allow"];

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "push-notification",
        approvalButtons,
        { timeoutMs: 20_000 },
      );

      // Then
      expect(status).toBe("success");
    });
  });

  // Placed after read-only tests so a signing failure doesn't cascade-
  // affect Storage, Chain, Contract, etc. via fixture restarts.

  test.describe("Signing", () => {
    test("Sign Raw Message", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(180_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "wallet-sign-message",
        ["Allow", "Sign"],
        { timeoutMs: 120_000, preClickDelayMs: 1_000 },
      );

      // Then
      expect(status).toBe("success");
    });
  });

  // Signer paths that need no balance: an intentionally invalid broadcast,
  // offline signing, and revive writes paying fees from the PGAS slot.
  test.describe("Transactions", () => {
    test("Chain Tx: Broadcast", async ({ pairedPage, productFrame }) => {
      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "chain-transaction-broadcast",
        ["Allow"],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe("success");
    });

    test("Chain Tx: Stop Broadcast", async ({ pairedPage, productFrame }) => {
      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "chain-transaction-stop",
        ["Allow"],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe("success");
    });

    // The signing host refuses product-account createTransaction while the
    // chain's tx-extension pipeline (v0) lacks VerifyMultiSignature. Same below.
    test.fixme("Create Transaction", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "create-transaction",
        ["Allow", "Sign"],
        { timeoutMs: 60_000 },
      );

      // Then
      expect(status).toBe("success");
    });

    test.fixme("Contract: Store Value", async ({
      pairedPage,
      productFrame,
    }) => {
      // Given
      test.setTimeout(150_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "contract-store-value",
        ["Allow", "Sign"],
        { timeoutMs: 90_000 },
      );

      // Then
      expect(status).toBe("success");
    });

    test.fixme("Sign Batch Payload", async ({ pairedPage, productFrame }) => {
      // Given: the card waits for finality, not best-block inclusion.
      test.setTimeout(240_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "sign-batch-payload",
        ["Allow", "Sign"],
        { timeoutMs: 180_000 },
      );

      // Then
      expect(status).toBe("success");
    });
  });

  // Payable calls move PAS from the per-run product account, which nothing
  // funds yet. Skipped until a globalSetup faucet step tops it up.
  test.describe("Funded operations", () => {
    test.skip("Contract: Deposit (payable)", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "contract-deposit");
    });
    test.skip("Contract: Withdraw", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "contract-withdraw");
    });
    // The core answers every coin_payment method with Unsupported, and the
    // card would pass vacuously with zero updates. Skip until payments land.
    test.skip("Payment: Balance Subscribe", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "payment-balance-subscribe");
    });
  });

  // dot.li answers device permissions with its own Permission Request modal,
  // which the fixture's auto-allow poller accepts. No system prompt is hit.
  test.describe("Device permissions", () => {
    // Granting a Permissions Policy directive re-renders the product iframe
    // so the new `allow` attribute applies, which also wipes the results.
    const RELOADING = [
      ["Camera", "camera"],
      ["Microphone", "microphone"],
      ["Bluetooth", "bluetooth"],
      ["Biometrics", "biometrics"],
      ["Clipboard", "clipboard"],
      ["Location", "location"],
      ["NFC", "nfc"],
    ] as const;

    for (const [name, id] of RELOADING) {
      test(name, async ({ pairedPage }) => {
        await grantReloadingDevicePermission(
          pairedPage,
          `device-permission-${id}`,
        );
      });
    }

    // Notifications has no policy directive and OpenUrl is auto-granted, so
    // neither re-renders the iframe. Re-find the frame after the tests above.
    test("Notifications", async ({ pairedPage }) => {
      const frame = await currentProductFrame(pairedPage);
      await runTestExpectSuccess(frame, "device-permission-notifications");
    });

    test("Open URL", async ({ pairedPage }) => {
      const frame = await currentProductFrame(pairedPage);
      await runTestExpectSuccess(frame, "device-permission-open-url");
    });
  });
});

/**
 * Click a device permission card whose grant re-renders the product iframe.
 * The first click raises the modal; once it is accepted the host boots a
 * replacement frame and detaches this one, so wait for the fresh frame and
 * click again, when the stored grant answers at once. When the permission is
 * already granted (a retry) the first click settles in place instead.
 */
async function grantReloadingDevicePermission(
  page: Page,
  testId: string,
): Promise<void> {
  const frame = await currentProductFrame(page);
  const entries = frame.locator('[data-testid="log-entry"]');
  const initialCount = await entries.count();
  const button = frame.locator(`[data-testid="run-${testId}"]`);
  await expect(button).toBeVisible({ timeout: 10_000 });
  await button.click();

  const deadline = Date.now() + 40_000;
  let settledAt: number | null = null;
  while (!frame.isDetached()) {
    if (Date.now() > deadline) {
      throw new Error(`${testId}: no reload and no result within 40s`);
    }
    if (settledAt === null) {
      const count = await entries.count().catch(() => 0);
      if (count > initialCount) {
        settledAt = Date.now();
      }
    } else if (Date.now() - settledAt > 8_000) {
      // The grant was already stored, so the card resolved without a reload.
      await expect(entries.first()).toHaveAttribute("data-status", "success");
      return;
    }
    await page.waitForTimeout(250);
  }

  const reloaded = await currentProductFrame(page);
  await waitForPlaygroundReady(reloaded);
  await runTestExpectSuccess(reloaded, testId);
}
