// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import { getMimeType } from "@dotli/shared/mime";

describe("getMimeType", () => {
  it("returns text/html for .html", () => {
    expect(getMimeType("index.html")).toBe("text/html");
  });

  it("returns text/html for .htm", () => {
    expect(getMimeType("page.htm")).toBe("text/html");
  });

  it("returns application/javascript for .js", () => {
    expect(getMimeType("app.js")).toBe("application/javascript");
  });

  it("returns application/javascript for .mjs", () => {
    expect(getMimeType("module.mjs")).toBe("application/javascript");
  });

  it("returns text/css for .css", () => {
    expect(getMimeType("styles.css")).toBe("text/css");
  });

  it("returns application/json for .json", () => {
    expect(getMimeType("data.json")).toBe("application/json");
  });

  it("returns application/wasm for .wasm", () => {
    expect(getMimeType("module.wasm")).toBe("application/wasm");
  });

  it("returns image types correctly", () => {
    expect(getMimeType("photo.png")).toBe("image/png");
    expect(getMimeType("photo.jpg")).toBe("image/jpeg");
    expect(getMimeType("photo.jpeg")).toBe("image/jpeg");
    expect(getMimeType("anim.gif")).toBe("image/gif");
    expect(getMimeType("icon.svg")).toBe("image/svg+xml");
    expect(getMimeType("favicon.ico")).toBe("image/x-icon");
    expect(getMimeType("img.webp")).toBe("image/webp");
  });

  it("returns font types correctly", () => {
    expect(getMimeType("font.woff")).toBe("font/woff");
    expect(getMimeType("font.woff2")).toBe("font/woff2");
    expect(getMimeType("font.ttf")).toBe("font/ttf");
    expect(getMimeType("font.otf")).toBe("font/otf");
  });

  it("returns media types correctly", () => {
    expect(getMimeType("video.mp4")).toBe("video/mp4");
    expect(getMimeType("video.webm")).toBe("video/webm");
    expect(getMimeType("audio.mp3")).toBe("audio/mpeg");
    expect(getMimeType("audio.wav")).toBe("audio/wav");
    expect(getMimeType("audio.ogg")).toBe("audio/ogg");
  });

  it("returns application/octet-stream for unknown extension", () => {
    expect(getMimeType("file.xyz")).toBe("application/octet-stream");
  });

  it("returns application/octet-stream for no extension", () => {
    expect(getMimeType("Makefile")).toBe("application/octet-stream");
  });

  it("uses the last extension for double extensions", () => {
    expect(getMimeType("archive.tar.gz")).toBe("application/octet-stream");
    expect(getMimeType("styles.module.css")).toBe("text/css");
  });

  it("is case-insensitive", () => {
    expect(getMimeType("FILE.HTML")).toBe("text/html");
    expect(getMimeType("image.PNG")).toBe("image/png");
    expect(getMimeType("style.CSS")).toBe("text/css");
  });

  it("handles paths with directories", () => {
    expect(getMimeType("assets/js/app.js")).toBe("application/javascript");
    expect(getMimeType("/deep/path/to/image.png")).toBe("image/png");
  });

  it("handles dot-only filename", () => {
    expect(getMimeType(".gitignore")).toBe("application/octet-stream");
  });
});
