// @vitest-environment node
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { parsers } from "prettier/plugins/babel";
import type { ParserOptions } from "prettier";
import { formatReadable } from "./polkavm-readable-format";
import { WORKSPACE_LIMITS } from "@dotli/shared/workspace-limits";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

async function programStructure(source: string): Promise<unknown> {
  const ast: unknown = await parsers.babel.parse(source, {} as ParserOptions);
  return JSON.parse(
    JSON.stringify(ast, (key, value: unknown) => {
      // Position and literal spelling can change; semantic AST nodes must not.
      switch (key) {
        case "start":
        case "end":
        case "loc":
        case "range":
        case "extra":
        case "tokens":
          return undefined;
        default:
          return value;
      }
    }),
  );
}

describe("readable copies", () => {
  it("preserves JavaScript structure and never executes its source", async () => {
    const source =
      'globalThis.__readableFormatterExecuted=true;throw new Error("do not run");' +
      "const text=String.raw`a\\nb`;const pattern=/a+/gi;" +
      "const css=s=>s.raw[0];const style=css`a{color:red}`;" +
      "function asi(){return\n{value:1}}export const view=<div>{text}</div>;";
    expect(Reflect.has(globalThis, "__readableFormatterExecuted")).toBe(false);
    const original = encoder.encode(source);
    const before = original.slice();
    const formatted = decoder.decode(
      await formatReadable("/home/app.jsx", original),
    );
    expect(Reflect.has(globalThis, "__readableFormatterExecuted")).toBe(false);
    expect(original).toEqual(before);
    expect(formatted).not.toBe(source);
    expect(await programStructure(formatted)).toEqual(
      await programStructure(source),
    );
  });

  it("preserves JSON data including non-ASCII text", async () => {
    const source =
      '{"greeting":"héllo 世界","items":[1,true,null,{"value":"\\n"}]}';
    const formatted = decoder.decode(
      await formatReadable("/home/data.json", encoder.encode(source)),
    );
    expect(JSON.parse(formatted)).toEqual(JSON.parse(source));
  });

  it("rejects unsupported files, malformed syntax, and invalid UTF-8", async () => {
    await expect(
      formatReadable("/home/code.ts", encoder.encode("let a=1")),
    ).rejects.toThrow();
    await expect(
      formatReadable("/home/code.js", encoder.encode("const = ;")),
    ).rejects.toThrow();
    await expect(
      formatReadable("/home/data.json", encoder.encode('{"x":1,}')),
    ).rejects.toThrow();
    await expect(
      formatReadable("/home/data.json", encoder.encode('{/*comment*/"x":1}')),
    ).rejects.toThrow();
    await expect(
      formatReadable("/home/code.js", new Uint8Array([0xc3, 0x28])),
    ).rejects.toThrow();
    await expect(
      formatReadable("/home/code.js", new Uint8Array([0xe2, 0x82])),
    ).rejects.toThrow();
  });

  it("accepts an exact-limit result but rejects expansion without truncating", async () => {
    const atLimit = encoder.encode(
      JSON.stringify("x".repeat(WORKSPACE_LIMITS.maxFileBytes - 3)),
    );
    const formatted = await formatReadable("/home/data.json", atLimit);
    expect(formatted.byteLength).toBe(WORKSPACE_LIMITS.maxFileBytes);
    expect(JSON.parse(decoder.decode(formatted))).toBe(
      JSON.parse(decoder.decode(atLimit)),
    );

    const expandsPastLimit = encoder.encode(
      JSON.stringify("x".repeat(WORKSPACE_LIMITS.maxFileBytes - 2)),
    );
    await expect(
      formatReadable("/home/data.json", expandsPastLimit),
    ).rejects.toThrow();
    expect(expandsPastLimit.byteLength).toBe(WORKSPACE_LIMITS.maxFileBytes);

    const nonAsciiExpansion = encoder.encode(
      JSON.stringify("é".repeat((WORKSPACE_LIMITS.maxFileBytes - 2) / 2)),
    );
    await expect(
      formatReadable("/home/data.json", nonAsciiExpansion),
    ).rejects.toThrow();
    await expect(
      formatReadable(
        "/home/code.js",
        new Uint8Array(WORKSPACE_LIMITS.maxFileBytes + 1),
      ),
    ).rejects.toThrow();
  });
});
