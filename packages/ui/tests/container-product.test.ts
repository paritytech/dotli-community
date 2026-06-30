// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  identifierToLabel,
  isDevPreviewLabel,
  isProductAccountValid,
  isUint8ArrayLike,
  labelAcceptsIdentifier,
  labelToProductIdentifier,
  resolveProductAccountId,
} from "@dotli/ui/container-product";

describe("isDevPreviewLabel", () => {
  it("treats localhost proxy hosts as dev previews", () => {
    expect(isDevPreviewLabel("localhost:5173")).toBe(true);
  });

  it("treats webcontainer hosts as dev previews", () => {
    expect(isDevPreviewLabel("abc-123.webcontainer-api.io")).toBe(true);
  });

  it("treats a normal deployed label as not a dev preview", () => {
    expect(isDevPreviewLabel("myapp")).toBe(false);
  });
});

describe("labelToProductIdentifier", () => {
  it("appends .dot to a deployed label", () => {
    expect(labelToProductIdentifier("myapp")).toBe("myapp.dot");
  });

  it("keeps the bare host for dev previews", () => {
    expect(labelToProductIdentifier("localhost:5173")).toBe("localhost:5173");
  });
});

describe("identifierToLabel", () => {
  it("strips the .dot suffix", () => {
    expect(identifierToLabel("myapp.dot")).toBe("myapp");
  });
});

describe("labelAcceptsIdentifier", () => {
  it("accepts the label's own derived identifier", () => {
    expect(labelAcceptsIdentifier("myapp", "myapp.dot")).toBe(true);
  });

  it("accepts any valid product identifier (.dot)", () => {
    expect(labelAcceptsIdentifier("myapp", "other.dot")).toBe(true);
  });

  it("rejects a non-product, non-matching identifier", () => {
    expect(labelAcceptsIdentifier("myapp", "garbage")).toBe(false);
  });
});

describe("isProductAccountValid", () => {
  it("requires a deployed label to sign as its own identifier", () => {
    expect(isProductAccountValid("myapp", "myapp.dot")).toBe(true);
    expect(isProductAccountValid("myapp", "evil.dot")).toBe(false);
  });

  it("is permissive for dev previews", () => {
    expect(isProductAccountValid("localhost:5173", "anything.dot")).toBe(true);
  });
});

describe("resolveProductAccountId", () => {
  it("forces a deployed label to its own identifier, ignoring the reported one", () => {
    const resolved = resolveProductAccountId("myapp", ["evil.dot", undefined]);
    expect(resolved[0]).toBe("myapp.dot");
  });

  it("passes the reported identifier through for dev previews", () => {
    const resolved = resolveProductAccountId("localhost:5173", [
      "whatever.dot",
      undefined,
    ]);
    expect(resolved[0]).toBe("whatever.dot");
  });
});

describe("isUint8ArrayLike", () => {
  it("accepts a real Uint8Array", () => {
    expect(isUint8ArrayLike(new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it("accepts a cross-realm Uint8Array by constructor name", () => {
    const crossRealm = { constructor: { name: "Uint8Array" } };
    expect(isUint8ArrayLike(crossRealm)).toBe(true);
  });

  it("rejects non-objects and plain values", () => {
    expect(isUint8ArrayLike(null)).toBe(false);
    expect(isUint8ArrayLike("bytes")).toBe(false);
    expect(isUint8ArrayLike([1, 2, 3])).toBe(false);
  });
});
