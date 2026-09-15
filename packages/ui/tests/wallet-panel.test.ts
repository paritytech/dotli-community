import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setupTruapiDebugPanel,
  type InspectorIdentity,
  type SetupOptions,
} from "@dotli/truapi-debug/panel";
import { dispatchAuthState } from "@dotli/ui/host-callbacks/AuthState";

type Wallet = NonNullable<SetupOptions["experimentalWallet"]>;
const cached: InspectorIdentity = {
  network: "Paseo",
  identityAccountId: `0x${"ab".repeat(32)}`,
  liteUsername: "alice.02",
};

async function unexpectedOperation(): Promise<never> {
  throw new Error("Unexpected native wallet mutation");
}

function button(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (result === undefined) throw new Error(`Missing button: ${label}`);
  return result;
}

let wallet: Wallet;
let dispose: (() => void) | undefined;

beforeEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
  wallet = {
    isActive: () => true,
    networkLabel: () => "Paseo",
    getCachedIdentity: () => cached,
    getIdentity: vi.fn(),
    getProduct: async () => null,
    describeResource: () => null,
    requestResource: unexpectedOperation,
    refreshUsername: async () => cached,
    claimLiteUsername: unexpectedOperation,
    activate: unexpectedOperation,
    disconnect: unexpectedOperation,
    exportMnemonic: unexpectedOperation,
    importMnemonic: unexpectedOperation,
    deleteWallet: unexpectedOperation,
  };
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("wallet failure presentation", () => {
  it("retains cached display without retrying native startup until explicitly requested", async () => {
    const pending = Promise.withResolvers<InspectorIdentity>();
    const getIdentity = vi.fn(() => pending.promise);
    wallet.getIdentity = getIdentity;
    dispose = setupTruapiDebugPanel({ experimentalWallet: wallet });
    expect(document.querySelector(".td-wallet-entry")?.textContent).toContain(
      cached.liteUsername,
    );

    dispatchAuthState({
      tag: "WalletUnavailable",
      reason: "Native worker stopped",
    });
    pending.reject(new Error("Native worker stopped"));
    await vi.waitFor(() => {
      expect(
        document.querySelector(".td-wallet-username")?.textContent,
      ).toContain("Native worker stopped");
      expect(button("Retry wallet verification").disabled).toBe(false);
    });
    expect(getIdentity).toHaveBeenCalledTimes(1);
    expect(button("Claim Lite username").disabled).toBe(true);
    expect(document.querySelector(".td-wallet-entry")?.textContent).toContain(
      cached.liteUsername,
    );

    getIdentity.mockResolvedValue(cached);
    button("Retry wallet verification").click();
    await vi.waitFor(() => {
      expect(document.querySelector(".td-wallet-entry")?.textContent).toBe(
        cached.liteUsername,
      );
      expect(button("Refresh username").disabled).toBe(false);
    });
    expect(getIdentity).toHaveBeenCalledTimes(2);
  });

  it("does not let a late successful identity read erase a native failure", async () => {
    const pending = Promise.withResolvers<InspectorIdentity>();
    const getIdentity = vi.fn(() => pending.promise);
    wallet.getIdentity = getIdentity;
    dispose = setupTruapiDebugPanel({ experimentalWallet: wallet });
    dispatchAuthState({
      tag: "WalletUnavailable",
      reason: "Native worker stopped",
    });
    pending.resolve({ ...cached, liteUsername: "stale.02" });
    await pending.promise;
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(
      document.querySelector(".td-wallet-username")?.textContent,
    ).toContain("Native worker stopped");
    expect(document.querySelector(".td-wallet-entry")?.textContent).toContain(
      cached.liteUsername,
    );
    expect(button("Claim Lite username").disabled).toBe(true);
    expect(button("Retry wallet verification").disabled).toBe(false);
    expect(getIdentity).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect a disconnected wallet by automatically querying identity", async () => {
    const getIdentity = vi.fn(async () => cached);
    wallet.getIdentity = getIdentity;
    dispose = setupTruapiDebugPanel({ experimentalWallet: wallet });
    await vi.waitFor(() => {
      expect(document.querySelector(".td-wallet-entry")?.textContent).toBe(
        cached.liteUsername,
      );
    });
    dispatchAuthState({ tag: "Disconnected" });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(getIdentity).toHaveBeenCalledTimes(1);
    expect(button("Claim Lite username").disabled).toBe(true);
    expect(button("Retry wallet verification").disabled).toBe(false);
  });
});
