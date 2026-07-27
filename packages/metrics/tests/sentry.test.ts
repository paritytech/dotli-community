// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import {
  excludeBrowserApiErrorsIntegration,
  isSmoldotEvent,
} from "../src/sentry";

describe("excludeBrowserApiErrorsIntegration", () => {
  it("As a host user, my callbacks remain intact when Sentry starts", () => {
    // Given
    const defaults = [
      { name: "GlobalHandlers" },
      { name: "BrowserApiErrors" },
      { name: "Breadcrumbs" },
    ];

    // When
    const integrations = excludeBrowserApiErrorsIntegration(defaults);

    // Then
    expect(integrations).toEqual([
      { name: "GlobalHandlers" },
      { name: "Breadcrumbs" },
    ]);
    expect(defaults).toHaveLength(3);
  });
});

describe("isSmoldotEvent", () => {
  it("matches a CrashError exception type", () => {
    expect(
      isSmoldotEvent({
        exception: {
          values: [{ type: "CrashError", value: "anything" }],
        },
      }),
    ).toBe(true);
  });

  it("matches a Rust panic message from the smoldot repo", () => {
    expect(
      isSmoldotEvent({
        exception: {
          values: [
            {
              type: "Error",
              value:
                "panicked at /__w/smoldot/smoldot/light-base/src/json_rpc_service/background.rs:4713:38:\ncalled `Option::unwrap()` on a `None` value",
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it("matches a stack frame inside the Bun-versioned smoldot package", () => {
    expect(
      isSmoldotEvent({
        exception: {
          values: [
            {
              type: "Error",
              value: "something else",
              stacktrace: {
                frames: [
                  {
                    filename:
                      "app:///node_modules/.bun/smoldot@2.0.40/node_modules/smoldot/dist/mjs/public-types.js",
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it("matches a frame when only abs_path is populated", () => {
    expect(
      isSmoldotEvent({
        exception: {
          values: [
            {
              stacktrace: {
                frames: [{ abs_path: "/vendor/smoldot/dist/mjs/client.js" }],
              },
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it("does not match unrelated browser errors", () => {
    expect(
      isSmoldotEvent({
        exception: {
          values: [
            {
              type: "TypeError",
              value: "Cannot read properties of undefined (reading 'foo')",
              stacktrace: {
                frames: [
                  { filename: "app:///src/main.ts" },
                  { filename: "app:///node_modules/react/index.js" },
                ],
              },
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it("returns false for events with no exception", () => {
    expect(isSmoldotEvent({})).toBe(false);
    expect(isSmoldotEvent({ exception: { values: [] } })).toBe(false);
  });
});
