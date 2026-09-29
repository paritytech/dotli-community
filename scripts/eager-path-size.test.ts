// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eagerChunkPaths } from "./eager-path-size.ts";

describe("eagerChunkPaths", () => {
  it("returns the module entry and every modulepreload, in document order", () => {
    const html = `<head>
      <script type="module" crossorigin src="/assets/index-AAAAAAAA.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/spans-BBBBBBBB.js">
      <link rel="stylesheet" href="/assets/index-CCCCCCCC.css">
      <link rel="modulepreload" crossorigin href="/assets/client-DDDDDDDD.js">
    </head>`;
    assert.deepEqual(eagerChunkPaths(html), [
      "/assets/index-AAAAAAAA.js",
      "/assets/spans-BBBBBBBB.js",
      "/assets/client-DDDDDDDD.js",
    ]);
  });

  it("accepts attributes in any order and relative paths", () => {
    const html = `<script src="./assets/index-AAAAAAAA.js" type="module"></script>
      <link href="./assets/fetch-BBBBBBBB.js" rel="modulepreload">`;
    assert.deepEqual(eagerChunkPaths(html), [
      "./assets/index-AAAAAAAA.js",
      "./assets/fetch-BBBBBBBB.js",
    ]);
  });

  it("counts a chunk once when it is listed twice", () => {
    const html = `<script type="module" src="/assets/index-AAAAAAAA.js"></script>
      <link rel="modulepreload" href="/assets/index-AAAAAAAA.js">
      <link rel="modulepreload" href="/assets/utils-BBBBBBBB.js">
      <link rel="modulepreload" href="/assets/utils-BBBBBBBB.js">`;
    assert.deepEqual(eagerChunkPaths(html), [
      "/assets/index-AAAAAAAA.js",
      "/assets/utils-BBBBBBBB.js",
    ]);
  });

  it("ignores classic scripts and non-module links", () => {
    const html = `<script type="module" src="/assets/index-AAAAAAAA.js"></script>
      <script src="/legacy.js"></script>
      <link rel="preload" href="/assets/font.woff2">`;
    assert.deepEqual(eagerChunkPaths(html), ["/assets/index-AAAAAAAA.js"]);
  });

  it("throws when the page has no module entry, instead of reporting 0 bytes", () => {
    assert.throws(
      () => eagerChunkPaths("<html><body></body></html>"),
      /no <script type="module" src>/,
    );
  });
});
