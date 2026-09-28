// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "bun:test";
import { eagerChunkPaths } from "./eager-path-size";

describe("eagerChunkPaths", () => {
  it("returns the module entry and every modulepreload, in document order", () => {
    const html = `<head>
      <script type="module" crossorigin src="/assets/index-AAAAAAAA.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/spans-BBBBBBBB.js">
      <link rel="stylesheet" href="/assets/index-CCCCCCCC.css">
      <link rel="modulepreload" crossorigin href="/assets/client-DDDDDDDD.js">
    </head>`;
    expect(eagerChunkPaths(html)).toEqual([
      "/assets/index-AAAAAAAA.js",
      "/assets/spans-BBBBBBBB.js",
      "/assets/client-DDDDDDDD.js",
    ]);
  });

  it("accepts attributes in any order and relative paths", () => {
    const html = `<script src="./assets/index-AAAAAAAA.js" type="module"></script>
      <link href="./assets/fetch-BBBBBBBB.js" rel="modulepreload">`;
    expect(eagerChunkPaths(html)).toEqual([
      "./assets/index-AAAAAAAA.js",
      "./assets/fetch-BBBBBBBB.js",
    ]);
  });

  it("counts a chunk once when it is listed twice", () => {
    const html = `<script type="module" src="/assets/index-AAAAAAAA.js"></script>
      <link rel="modulepreload" href="/assets/index-AAAAAAAA.js">
      <link rel="modulepreload" href="/assets/utils-BBBBBBBB.js">
      <link rel="modulepreload" href="/assets/utils-BBBBBBBB.js">`;
    expect(eagerChunkPaths(html)).toEqual([
      "/assets/index-AAAAAAAA.js",
      "/assets/utils-BBBBBBBB.js",
    ]);
  });

  it("ignores classic scripts and non-module links", () => {
    const html = `<script type="module" src="/assets/index-AAAAAAAA.js"></script>
      <script src="/legacy.js"></script>
      <link rel="preload" href="/assets/font.woff2">`;
    expect(eagerChunkPaths(html)).toEqual(["/assets/index-AAAAAAAA.js"]);
  });

  it("throws when the page has no module entry, instead of reporting 0 bytes", () => {
    expect(() => eagerChunkPaths("<html><body></body></html>")).toThrow(
      /no <script type="module" src>/,
    );
  });
});
