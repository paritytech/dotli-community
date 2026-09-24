import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { ProductContext } from "@parity/truapi-host";
import { createSubmitRateLimiter } from "@dotli/ui/host-callbacks/rate-limit";
import { createHostCallbacks } from "@dotli/ui/host-callbacks/handlers";
import { registerPermissionAuthorizationProvider } from "@dotli/ui/permissions";

const PRODUCT: ProductContext = {
  productId: "myapp.paseo",
  executionKind: "App",
};

const mocks = vi.hoisted(() => ({
  scheduleNotification: vi.fn(),
  cancelNotification: vi.fn(),
  showPermissionRequestModal: vi.fn(),
}));

vi.mock("@dotli/ui/scheduled-notifications", () => ({
  scheduleNotification: mocks.scheduleNotification,
  cancelNotification: mocks.cancelNotification,
}));

vi.mock("@dotli/ui/permission-modal", () => ({
  showPermissionRequestModal: mocks.showPermissionRequestModal,
}));

// Mirror of SUBMIT_WINDOW_MS / SUBMIT_MAX_PER_WINDOW in rate-limit.ts.
const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 20;

describe("createSubmitRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("As a dotli integrator, the host allows prompts up to the window budget and denies the next", () => {
    // Given
    const limiter = createSubmitRateLimiter();

    // When / Then
    for (let i = 0; i < MAX_PER_WINDOW; i += 1) {
      expect(limiter.allow()).toBe(true);
    }
    expect(limiter.allow()).toBe(false);
  });

  it("As a dotli integrator, the host frees budget as prompts age out of the sliding window", () => {
    // Given: half the budget spent now, the other half just before the
    // window boundary.
    const limiter = createSubmitRateLimiter();
    for (let i = 0; i < MAX_PER_WINDOW / 2; i += 1) {
      limiter.allow();
    }
    vi.advanceTimersByTime(WINDOW_MS - 1);
    for (let i = 0; i < MAX_PER_WINDOW / 2; i += 1) {
      limiter.allow();
    }

    // Then: the window is full until the first half expires.
    expect(limiter.allow()).toBe(false);

    // When: the first half ages out.
    vi.advanceTimersByTime(1);

    // Then: exactly that much budget is back, no more.
    for (let i = 0; i < MAX_PER_WINDOW / 2; i += 1) {
      expect(limiter.allow()).toBe(true);
    }
    expect(limiter.allow()).toBe(false);
  });

  it("As a dotli integrator, the host denials do not consume budget", () => {
    // Given: a full window.
    const limiter = createSubmitRateLimiter();
    for (let i = 0; i < MAX_PER_WINDOW; i += 1) {
      limiter.allow();
    }

    // When: repeated denied attempts inside the window.
    expect(limiter.allow()).toBe(false);
    expect(limiter.allow()).toBe(false);

    // Then: once the window empties, the full budget is available again —
    // denied attempts did not extend it.
    vi.advanceTimersByTime(WINDOW_MS);
    expect(limiter.allow()).toBe(true);
  });
});

describe("prompt rate limiting across host callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = "";
    mocks.showPermissionRequestModal.mockResolvedValue("granted");
    mocks.scheduleNotification.mockResolvedValue({
      ok: true,
      id: 7,
      immediate: false,
    });
  });

  it("As a dotli integrator, the host counts permission and notification prompts against one shared budget", async () => {
    // Reset the real grant between prompts to exercise one callback's shared budget.
    let status: "NotDetermined" | "Denied" | "Authorized" = "NotDetermined";
    const unregister = registerPermissionAuthorizationProvider("myapp", {
      async getPermissionAuthorizationStatuses(requests) {
        return requests.map(() => status);
      },
      async setPermissionAuthorizationStatus(_request, next) {
        status = next;
      },
    });
    onTestFinished(unregister);
    const { permissions } = createHostCallbacks({
      label: "myapp",
    });

    // When: camera prompts exhaust the whole window budget.
    for (let i = 0; i < MAX_PER_WINDOW; i += 1) {
      status = "NotDetermined";
      await permissions.devicePermission(PRODUCT, "Camera");
    }
    status = "NotDetermined";

    // Then: a different permission shares that budget and is rate limited
    // instead of showing a 21st modal.
    await expect(
      permissions.devicePermission(PRODUCT, "Notifications"),
    ).rejects.toThrow("Permission prompt rate limited");
    expect(mocks.showPermissionRequestModal).toHaveBeenCalledTimes(
      MAX_PER_WINDOW,
    );
  });

  it("As a dotli user, delivering notifications never spends the prompt budget", async () => {
    // Given
    let status: "NotDetermined" | "Denied" | "Authorized" = "NotDetermined";
    const unregister = registerPermissionAuthorizationProvider("myapp", {
      async getPermissionAuthorizationStatuses(requests) {
        return requests.map(() => status);
      },
      async setPermissionAuthorizationStatus(_request, next) {
        status = next;
      },
    });
    onTestFinished(unregister);
    const { permissions, notifications } = createHostCallbacks({
      label: "myapp",
    });
    for (let i = 0; i < MAX_PER_WINDOW; i += 1) {
      status = "NotDetermined";
      await permissions.devicePermission(PRODUCT, "Camera");
    }

    // When
    const delivered = notifications.pushNotification({
      text: "hello",
      deeplink: undefined,
      scheduledAt: undefined,
    });

    // Then
    await expect(delivered).resolves.toEqual({ id: 7 });
  });
});
