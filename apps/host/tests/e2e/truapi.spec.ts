// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect } from "./fixtures/paired";
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

    test("Product Account Alias", async ({ productFrame }) => {
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
  // approves. The bot is auto-paired so the modal click is what the suite
  // drives via runWebSignedTest with a single-button list.

  test.describe("Allowances", () => {
    test("StatementStore Allowance", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "allowances-statement-store",
        ["Allow"],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe("success");
    });

    test("Bulletin Allowance", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "allowances-bulletin",
        ["Allow"],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe("success");
    });

    test("Smart-Contract Allowance", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "allowances-smart-contract",
        ["Allow"],
        { timeoutMs: 30_000 },
      );

      // Then
      expect(status).toBe("success");
    });

    test("All Allowances", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(60_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "allowances-all",
        ["Allow"],
        { timeoutMs: 30_000 },
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
    test("Create Proof", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "statement-store-create-proof");
    });

    test("Submit", async ({ pairedPage, productFrame }) => {
      // Given
      test.setTimeout(120_000);

      // When
      const status = await runWebSignedTest(
        pairedPage,
        productFrame,
        "statement-store-submit",
        ["Allow", "Sign"],
        { timeoutMs: 60_000, preClickDelayMs: 1_000 },
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

    test("In-App", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "navigate-internal");
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
        ["Allow", "Sign"],
        { timeoutMs: 60_000, preClickDelayMs: 1_000 },
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
        ["Allow", "Sign"],
        { timeoutMs: 60_000, preClickDelayMs: 1_000 },
      );

      // Then
      expect(status).toBe("success");
    });
  });

  test.describe("Notifications", () => {
    test("Push Notification", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "push-notification");
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
        "sign-raw",
        ["Allow", "Sign"],
        { timeoutMs: 120_000, preClickDelayMs: 1_000 },
      );

      // Then
      expect(status).toBe("success");
    });
  });

  // Funded operations (skipped, needs a faucet-funded account). Funded paths
  // exercise transaction submission. Out of scope until we wire a faucet step
  // into the fixture.
  test.describe("Funded operations", () => {
    test.skip("Sign Batch Payload", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "sign-batch-payload");
    });
    test.skip("Create Transaction", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "create-transaction");
    });
    test.skip("Contract: Store Value", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "contract-store-value");
    });
    test.skip("Contract: Deposit (payable)", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "contract-deposit");
    });
    test.skip("Contract: Withdraw", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "contract-withdraw");
    });
    test.skip("Chain Tx: Broadcast", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "chain-transaction-broadcast");
    });
    test.skip("Chain Tx: Stop Broadcast", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "chain-transaction-stop");
    });
    test.skip("Payment: Balance Subscribe", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "payment-balance-subscribe");
    });
  });

  // Device Permissions (skipped, mobile/system-level prompts). These hit
  // native system permission prompts on iOS/Android. In headless Chromium
  // they have no host-side equivalent. Listed for coverage parity with
  // host-playground.

  test.describe("Device permissions", () => {
    test.skip("Camera", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "device-permission-camera");
    });
    test.skip("Microphone", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "device-permission-microphone");
    });
    test.skip("Bluetooth", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "device-permission-bluetooth");
    });
    test.skip("Biometrics", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "device-permission-biometrics");
    });
    test.skip("Clipboard", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "device-permission-clipboard");
    });
    test.skip("Location", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "device-permission-location");
    });
    test.skip("NFC", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "device-permission-nfc");
    });
    test.skip("Notifications", async ({ productFrame }) => {
      await runTestExpectSuccess(
        productFrame,
        "device-permission-notifications",
      );
    });
    test.skip("Open URL", async ({ productFrame }) => {
      await runTestExpectSuccess(productFrame, "device-permission-open-url");
    });
  });
});
