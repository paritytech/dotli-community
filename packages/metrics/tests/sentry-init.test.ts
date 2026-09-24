// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/browser";
import { initSentry } from "../src/sentry";

// Sentry installs no integrations without a DSN. This one is never dialled:
// nothing is captured, and `tunnel` keeps any envelope same-origin anyway.
const DSN = "http://publickey@127.0.0.1:5173/1";

describe("initSentry", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_SENTRY_DSN", DSN);
  });

  afterEach(async () => {
    await Sentry.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("As a host user, my console output never reaches Sentry breadcrumbs", () => {
    // When
    initSentry("host");

    // Then
    const client = Sentry.getClient();
    expect(client?.getIntegrationByName("Breadcrumbs")).toBeDefined();
    expect(client?.getIntegrationByName("Console")).toBeUndefined();
  });

  it("As a worker, console breadcrumbs stay on as before", () => {
    // When
    initSentry("worker");

    // Then
    expect(Sentry.getClient()?.getIntegrationByName("Console")).toBeDefined();
  });

  it("As a user, Sentry never collects my user info or infers my IP", () => {
    // When
    initSentry("sandbox");

    // Then
    expect(Sentry.getClient()?.getDataCollectionOptions().userInfo).toBe(false);
  });
});
