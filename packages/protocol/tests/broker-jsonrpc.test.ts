// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  buildJsonRpcError,
  buildJsonRpcResult,
  cloneWithRewrittenFirstParam,
  encode,
  isJsonRpcObject,
  isRequestMessage,
  isResponseMessage,
  isSubscriptionMessage,
  normalizeUnpinHashes,
  parseInbound,
} from "@dotli/protocol/broker-jsonrpc";

describe("isJsonRpcObject", () => {
  it("accepts plain objects", () => {
    expect(isJsonRpcObject({})).toBe(true);
    expect(isJsonRpcObject({ jsonrpc: "2.0" })).toBe(true);
  });

  it("rejects null, arrays, and primitives", () => {
    expect(isJsonRpcObject(null)).toBe(false);
    expect(isJsonRpcObject([])).toBe(false);
    expect(isJsonRpcObject([1, 2])).toBe(false);
    expect(isJsonRpcObject("x")).toBe(false);
    expect(isJsonRpcObject(42)).toBe(false);
    expect(isJsonRpcObject(undefined)).toBe(false);
  });
});

describe("buildJsonRpcError / buildJsonRpcResult", () => {
  it("builds an internal-error envelope preserving the id", () => {
    expect(buildJsonRpcError(7, "boom")).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32603, message: "boom" },
    });
  });

  it("preserves a null id on errors", () => {
    expect(buildJsonRpcError(null, "bad")).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: "bad" },
    });
  });

  it("builds a result envelope preserving the id and result", () => {
    expect(buildJsonRpcResult("abc", { ok: true })).toEqual({
      jsonrpc: "2.0",
      id: "abc",
      result: { ok: true },
    });
  });

  it("carries a null result through", () => {
    expect(buildJsonRpcResult(1, null)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: null,
    });
  });
});

describe("message classifiers", () => {
  it("isRequestMessage requires a string method", () => {
    expect(isRequestMessage({ method: "chainHead_v1_follow" })).toBe(true);
    expect(isRequestMessage({ method: 5 })).toBe(false);
    expect(isRequestMessage({ id: 1 })).toBe(false);
    expect(isRequestMessage([])).toBe(false);
  });

  it("isResponseMessage requires an id and no method", () => {
    expect(isResponseMessage({ id: 1, result: "x" })).toBe(true);
    expect(isResponseMessage({ id: null, error: {} })).toBe(true);
    expect(isResponseMessage({ id: 1, method: "foo" })).toBe(false);
    expect(isResponseMessage({ result: "x" })).toBe(false);
  });

  it("isSubscriptionMessage requires params.subscription", () => {
    expect(
      isSubscriptionMessage({
        method: "chainHead_v1_followEvent",
        params: { subscription: "tok", result: {} },
      }),
    ).toBe(true);
    expect(isSubscriptionMessage({ method: "x", params: { result: {} } })).toBe(
      false,
    );
    expect(isSubscriptionMessage({ method: "x" })).toBe(false);
    expect(isSubscriptionMessage({ params: { subscription: "t" } })).toBe(
      false,
    );
  });
});

describe("parseInbound", () => {
  it("parses JSON strings into objects", () => {
    expect(parseInbound('{"a":1}')).toEqual({ a: 1 });
  });

  it("returns non-string values untouched", () => {
    const obj = { a: 1 };
    expect(parseInbound(obj)).toBe(obj);
  });

  it("throws on malformed JSON strings", () => {
    expect(() => parseInbound("{not json")).toThrow();
  });
});

describe("encode", () => {
  it("stringifies in string wire mode", () => {
    expect(encode({ a: 1 }, "string")).toBe('{"a":1}');
  });

  it("passes objects through in object wire mode", () => {
    const obj = { a: 1 };
    expect(encode(obj, "object")).toBe(obj);
  });
});

describe("normalizeUnpinHashes", () => {
  it("wraps a single string hash into an array", () => {
    expect(normalizeUnpinHashes("0xabc")).toEqual(["0xabc"]);
  });

  it("keeps only string members of an array", () => {
    expect(normalizeUnpinHashes(["0x1", 2, null, "0x2"])).toEqual([
      "0x1",
      "0x2",
    ]);
  });

  it("returns an empty array for unsupported shapes", () => {
    expect(normalizeUnpinHashes(undefined)).toEqual([]);
    expect(normalizeUnpinHashes(42)).toEqual([]);
    expect(normalizeUnpinHashes({})).toEqual([]);
  });
});

describe("cloneWithRewrittenFirstParam", () => {
  it("replaces the first param with the rewritten token", () => {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "chainHead_v1_unpin",
      params: ["localToken", ["0xabc"]],
    };
    const cloned = cloneWithRewrittenFirstParam(request, "upstreamToken");
    expect(cloned.params).toEqual(["upstreamToken", ["0xabc"]]);
    // other fields preserved
    expect(cloned.method).toBe("chainHead_v1_unpin");
    expect(cloned.id).toBe(1);
  });

  it("does not mutate the original request's params", () => {
    const request = { method: "m", params: ["original"] };
    cloneWithRewrittenFirstParam(request, "rewritten");
    expect(request.params).toEqual(["original"]);
  });

  it("creates a single-element params array when params is absent", () => {
    const cloned = cloneWithRewrittenFirstParam({ method: "m" }, "tok");
    expect(cloned.params).toEqual(["tok"]);
  });

  it("creates a single-element params array when params is not an array", () => {
    const cloned = cloneWithRewrittenFirstParam(
      { method: "m", params: "scalar" },
      "tok",
    );
    expect(cloned.params).toEqual(["tok"]);
  });
});
