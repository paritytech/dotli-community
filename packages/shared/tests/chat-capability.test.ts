// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_AVAILABILITY_EVENT,
  chatCapabilityFor,
  primeChatCapability,
  resetChatCapabilityForTests,
  setChatCapability,
  type ChatAvailabilityDetail,
} from "@dotli/shared/chat-capability";

function nextAnnouncement(): Promise<ChatAvailabilityDetail> {
  return new Promise((resolve) => {
    window.addEventListener(
      CHAT_AVAILABILITY_EVENT,
      (event) => {
        resolve((event as CustomEvent<ChatAvailabilityDetail>).detail);
      },
      { once: true },
    );
  });
}

describe("chat capability", () => {
  beforeEach(() => {
    localStorage.clear();
    resetChatCapabilityForTests();
  });

  it("As the bridge, an unprimed label resolves to no chat", async () => {
    expect(await chatCapabilityFor("unknown")).toBe(false);
  });

  it("As the bridge, priming resolves from the manifest and announces", async () => {
    const announced = nextAnnouncement();

    primeChatCapability("myapp", () => Promise.resolve(true));

    expect(await chatCapabilityFor("myapp")).toBe(true);
    expect(await announced).toEqual({ label: "myapp", chat: true });
    expect(await chatCapabilityFor("other")).toBe(false);
  });

  it("As the bridge, a cached value answers without waiting on the resolver", async () => {
    localStorage.setItem("dotli:chat-capable:myapp", "1");
    const resolver = vi.fn(() => new Promise<boolean>(() => undefined));

    primeChatCapability("myapp", resolver);

    expect(await chatCapabilityFor("myapp")).toBe(true);
    expect(resolver).toHaveBeenCalledOnce();
  });

  it("As the bridge, a fresh resolve updates the cache for the next load", async () => {
    const announced = nextAnnouncement();
    primeChatCapability("myapp", () => Promise.resolve(true));
    await announced;

    expect(localStorage.getItem("dotli:chat-capable:myapp")).toBe("1");
  });

  it("As the bridge, a failed resolve falls back to the cached value", async () => {
    localStorage.setItem("dotli:chat-capable:myapp", "1");
    const announced = nextAnnouncement();

    primeChatCapability("myapp", () => Promise.reject(new Error("offline")));

    expect(await chatCapabilityFor("myapp")).toBe(true);
    expect(await announced).toEqual({ label: "myapp", chat: true });
    expect(localStorage.getItem("dotli:chat-capable:myapp")).toBe("1");
  });

  it("As the debug path, a forced capability answers immediately", async () => {
    setChatCapability("localhost:5173", true);

    expect(await chatCapabilityFor("localhost:5173")).toBe(true);
  });
});
