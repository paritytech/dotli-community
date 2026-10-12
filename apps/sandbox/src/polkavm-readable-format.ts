// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { format } from "prettier/standalone";
import * as babel from "prettier/plugins/babel";
import * as estree from "prettier/plugins/estree";
import * as html from "prettier/plugins/html";
import * as postcss from "prettier/plugins/postcss";
import { WORKSPACE_LIMITS } from "@dotli/shared/workspace-limits";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const plugins = [babel, estree, html, postcss];

export function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Formatting failed.";
  return message.slice(0, 512);
}

/** Parse saved bytes only; standalone Prettier cannot load project configuration. */
export async function formatReadable(
  path: string,
  bytes: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    if (
      typeof path !== "string" ||
      path.length > WORKSPACE_LIMITS.maxPathBytes ||
      path.includes("\0")
    ) {
      throw new Error("Invalid formatter path.");
    }
    const pathBytes = encoder.encode(path);
    if (
      pathBytes.byteLength > WORKSPACE_LIMITS.maxPathBytes ||
      decoder.decode(pathBytes) !== path
    ) {
      throw new Error(
        "Formatter path must be valid UTF-8 and at most 200 bytes.",
      );
    }
    const extension = /\.([^.\/]+)$/.exec(path)?.[1].toLowerCase();
    let parser: "babel" | "html" | "css" | "json";
    switch (extension) {
      case "js":
      case "mjs":
      case "cjs":
      case "jsx":
        parser = "babel";
        break;
      case "html":
      case "htm":
        parser = "html";
        break;
      case "css":
        parser = "css";
        break;
      case "json":
        parser = "json";
        break;
      default:
        throw new Error(
          "Make Code Readable supports JS, JSX, HTML, CSS, and JSON files only.",
        );
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new Error("Formatter input must be UTF-8 bytes.");
    }
    if (bytes.byteLength > WORKSPACE_LIMITS.maxFileBytes) {
      throw new Error("Saved file exceeds the 1 MiB per-file limit.");
    }
    let source: string;
    try {
      source = decoder.decode(bytes);
    } catch {
      throw new Error("Saved file is not valid UTF-8.");
    }
    // Prettier's JSON parser also accepts comments; workspace JSON must be JSON.
    if (parser === "json") JSON.parse(source);
    const formatted = await format(source, {
      parser,
      plugins,
      embeddedLanguageFormatting: "off",
      htmlWhitespaceSensitivity: "strict",
      endOfLine: "lf",
    });
    if (formatted.length > WORKSPACE_LIMITS.maxFileBytes) {
      throw new Error("Readable copy exceeds the 1 MiB per-file limit.");
    }
    const result = encoder.encode(formatted);
    if (result.byteLength > WORKSPACE_LIMITS.maxFileBytes) {
      throw new Error("Readable copy exceeds the 1 MiB per-file limit.");
    }
    return result;
  } catch (error) {
    throw new Error(readableError(error));
  }
}
