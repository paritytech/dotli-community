import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("notification host callbacks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = "";
    mocks.scheduleNotification.mockResolvedValue({
      ok: true,
      id: 7,
      immediate: true,
    });
    mocks.cancelNotification.mockResolvedValue(true);
  });

  it("As a dotli integrator, the host schedules, fires immediate notifications, and returns ids", async () => {
    // Given
    const { createNotificationAdapters } =
      await import("@dotli/ui/host-callbacks/PushNotification");
    const { pushNotification } = createNotificationAdapters("myapp");

    // When
    const response = await pushNotification({
      text: "hello",
      deeplink: undefined,
      scheduledAt: undefined,
    });

    // Then
    expect(response).toEqual({ id: 7 });
    expect(mocks.scheduleNotification).toHaveBeenCalledWith({
      productId: "myapp",
      title: "myapp",
      text: "hello",
      deeplink: null,
      scheduledAt: null,
    });
    expect(
      [...document.querySelectorAll(".notif-body")].map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["hello"]);
  });

  it("As a dotli user who allowed one notification, delivering it does not prompt again", async () => {
    // Given: the core already authorized and consumed the one-time grant, so
    // no stored grant is left for a host-side check to find.
    const { createNotificationAdapters } =
      await import("@dotli/ui/host-callbacks/PushNotification");
    const { pushNotification } = createNotificationAdapters("myapp");

    // When
    await pushNotification({
      text: "hello",
      deeplink: undefined,
      scheduledAt: undefined,
    });

    // Then
    expect(mocks.showPermissionRequestModal).not.toHaveBeenCalled();
    expect(mocks.scheduleNotification).toHaveBeenCalledTimes(1);
  });

  it("As a dotli integrator, the host schedules later notifications and cancels through the shared scheduler", async () => {
    // Given
    const { createNotificationAdapters } =
      await import("@dotli/ui/host-callbacks/PushNotification");
    const { pushNotification, cancelNotification } =
      createNotificationAdapters("myapp");

    // When
    await pushNotification({
      text: "later",
      deeplink: "dot://open",
      scheduledAt: 123n,
    });
    await cancelNotification(7);

    // Then
    expect(mocks.scheduleNotification).toHaveBeenCalledWith({
      productId: "myapp",
      title: "myapp",
      text: "later",
      deeplink: "dot://open",
      scheduledAt: 123,
    });
    expect(mocks.cancelNotification).toHaveBeenCalledWith("myapp", 7);
  });

  it("As a dotli integrator, the host rejects when the schedule limit is reached", async () => {
    // Given
    mocks.scheduleNotification.mockResolvedValue({ ok: false });
    const { createNotificationAdapters } =
      await import("@dotli/ui/host-callbacks/PushNotification");
    const { pushNotification } = createNotificationAdapters("myapp");

    // When
    const notification = pushNotification({
      text: "hello",
      deeplink: undefined,
      scheduledAt: undefined,
    });

    // Then
    await expect(notification).rejects.toThrow("ScheduleLimitReached");
  });
});
