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
    mocks.showPermissionRequestModal.mockResolvedValue(undefined);
  });

  it("prompts for notification permission, schedules, fires immediate notifications, and returns ids", async () => {
    const { createNotificationAdapters } =
      await import("@dotli/ui/host-callbacks/PushNotification");
    const { pushNotification } = createNotificationAdapters("myapp");

    const response = await pushNotification({
      text: "hello",
      deeplink: undefined,
      scheduledAt: undefined,
    });

    expect(response).toEqual({ id: 7 });
    expect(mocks.showPermissionRequestModal).toHaveBeenCalledWith(
      "myapp",
      "Notifications",
    );
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

  it("reuses granted permission and cancels through the shared scheduler", async () => {
    localStorage.setItem(
      "dotli:permissions:myapp",
      JSON.stringify({ Notifications: "granted" }),
    );
    const { createNotificationAdapters } =
      await import("@dotli/ui/host-callbacks/PushNotification");
    const { pushNotification, cancelNotification } =
      createNotificationAdapters("myapp");

    await pushNotification({
      text: "later",
      deeplink: "dot://open",
      scheduledAt: 123n,
    });
    await cancelNotification(7);

    expect(mocks.showPermissionRequestModal).not.toHaveBeenCalled();
    expect(mocks.scheduleNotification).toHaveBeenCalledWith({
      productId: "myapp",
      title: "myapp",
      text: "later",
      deeplink: "dot://open",
      scheduledAt: 123,
    });
    expect(mocks.cancelNotification).toHaveBeenCalledWith("myapp", 7);
  });

  it("rejects when notification permission is denied", async () => {
    mocks.showPermissionRequestModal.mockRejectedValue(new Error("denied"));
    const { createNotificationAdapters } =
      await import("@dotli/ui/host-callbacks/PushNotification");
    const { pushNotification } = createNotificationAdapters("myapp");

    await expect(
      pushNotification({
        text: "hello",
        deeplink: undefined,
        scheduledAt: undefined,
      }),
    ).rejects.toThrow("Notifications permission denied");

    expect(mocks.scheduleNotification).not.toHaveBeenCalled();
    expect(localStorage.getItem("dotli:permissions:myapp")).toBe(
      '{"Notifications":"denied"}',
    );
  });

  it("reuses the shared blocked-permission path for stored notification denials", async () => {
    localStorage.setItem(
      "dotli:permissions:myapp",
      JSON.stringify({ Notifications: "denied" }),
    );
    const { createNotificationAdapters } =
      await import("@dotli/ui/host-callbacks/PushNotification");
    const { pushNotification } = createNotificationAdapters("myapp");

    await expect(
      pushNotification({
        text: "hello",
        deeplink: undefined,
        scheduledAt: undefined,
      }),
    ).rejects.toThrow("Notifications permission denied");

    expect(mocks.showPermissionRequestModal).not.toHaveBeenCalled();
    expect(mocks.scheduleNotification).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Notifications access is blocked. Use the permissions menu in the top bar to change this.",
    );
  });
});
