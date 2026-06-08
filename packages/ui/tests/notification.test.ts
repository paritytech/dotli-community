import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNotificationAdapters } from "@dotli/ui/host-callbacks/PushNotification";

describe("notification host callbacks", () => {
  beforeEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("fires immediate notifications and returns stable ids", async () => {
    const { pushNotification } = createNotificationAdapters("myapp");

    const first = await pushNotification({
      text: "hello",
      deeplink: undefined,
      scheduledAt: undefined,
    });
    const second = await pushNotification({
      text: "again",
      deeplink: undefined,
      scheduledAt: BigInt(Date.now() - 1),
    });

    expect(second.id).toBeGreaterThan(first.id);
    expect(
      [...document.querySelectorAll(".notif-body")].map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["hello", "again"]);
  });

  it("cancels future scheduled notifications by id", async () => {
    vi.useFakeTimers();
    const { pushNotification, cancelNotification } =
      createNotificationAdapters("myapp");

    const scheduled = await pushNotification({
      text: "later",
      deeplink: undefined,
      scheduledAt: BigInt(Date.now() + 5000),
    });

    expect(document.querySelectorAll(".notif-body")).toHaveLength(0);

    await cancelNotification(scheduled.id);
    await vi.advanceTimersByTimeAsync(5000);

    expect(document.querySelectorAll(".notif-body")).toHaveLength(0);
  });
});
