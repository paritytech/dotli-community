// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the host-shell origin downloads that it never runs.
 *
 * smoldot runs on the protocol origin, in the iframe for `smoldot-direct` and
 * in the SharedWorker for `smoldot-shared-worker`, and that origin serves its
 * own copy of the light client wasm from its own bundle. The host shell has a
 * second copy of the same 5.2 MB blob and never instantiates it, which is
 * confirmed by the `dotli.smoldot.active` gauge: it has never produced a point
 * without a `protocol_mode` tag, and only `apps/protocol` sets that tag.
 *
 * Downloading it anyway costs every visitor those megabytes on a cold load,
 * competing with the assets the page actually needs to render.
 *
 * Env overrides: DOMAIN, PORT, TIMEOUT_MS.
 */

import { test, expect } from "@playwright/test";
import { DOMAIN, PORT, TIMEOUT_MS } from "../env";
import { findAppFrame } from "../product-frame";
import { seedBackend } from "./fixtures/settings";

const HOST_URL = `http://${DOMAIN}.localhost:${PORT}/`;
const HOST_SHELL_ORIGIN = `http://${DOMAIN}.localhost:${PORT}`;

// The light client's wasm, hashed by Vite. The protocol origin serves the same
// filename, so the origin is what separates the legitimate fetch from the waste.
const LIGHT_CLIENT_WASM = /truapi_provider_bg.*\.wasm$/;

// Long enough for the eager fetch to happen if it is going to. Deliberately not
// derived from TIMEOUT_MS: a fail-fast run sets that low, and a budget scaled
// from it would expire inside this wait rather than reaching the assertion.
const SETTLE_MS = 20_000;

test("As a dotli visitor, the host shell must not download the light client wasm it never runs", async ({
  page,
}) => {
  // Given
  // Default transport, which is what a first visit gets (`defaultBackend()` in
  // packages/config/src/mode.ts returns "smoldot-direct").
  await seedBackend(page, "smoldot-direct", { onlyIfUnset: true });
  const hostShellWasm: string[] = [];
  page.context().on("request", (request) => {
    const url = request.url();
    if (url.startsWith(HOST_SHELL_ORIGIN) && LIGHT_CLIENT_WASM.test(url)) {
      hostShellWasm.push(url);
    }
  });

  // When
  await page.goto(HOST_URL, { waitUntil: "domcontentloaded" });
  expect(await findAppFrame(page, TIMEOUT_MS)).not.toBeNull();
  // The download is eager, but give a slow boot room to make it before
  // concluding it never happens.
  await page.waitForTimeout(SETTLE_MS);

  // Then
  expect(
    hostShellWasm,
    `the host shell fetched the light client wasm it never instantiates:\n${hostShellWasm.join("\n")}`,
  ).toEqual([]);
});
