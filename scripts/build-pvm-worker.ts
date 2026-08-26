#!/usr/bin/env bun
// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runtime = resolve(root, "apps/sandbox/public/pvm-runtime");
const translated = await readFile(
  resolve(runtime, "pvm-wasm-translated.js"),
  "utf8",
);
const worker = await readFile(
  resolve(runtime, "pvm-wasm-worker-entry.js"),
  "utf8",
);
await writeFile(
  resolve(runtime, "pvm-wasm-worker.js"),
  `${translated}\n${worker}`,
);
