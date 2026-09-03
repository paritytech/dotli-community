// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Functional coverage for the experimental `polkadot-host-computer/0.1`
// app kind: a real shell guest boots in the sandbox terminal, spawns the
// kilo editor as a sandboxed child VM, and /home persists across reloads.

import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { CarWriter } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import type { PBLink } from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SANDBOX_SCHEMA_VERSION } from "@dotli/config/host-sandbox-contract";

interface ComputerFixture {
  cid: string;
  bytes: Uint8Array;
  manifest: string;
}

async function computerCar(): Promise<ComputerFixture> {
  const fixture = join(import.meta.dirname, "fixtures/pvm-computer");
  const files = await Promise.all(
    [
      ["manifest.json", join(fixture, "manifest.json")],
      ["shell.polkavm", join(fixture, "shell.polkavm")],
      ["kilo.polkavm", join(fixture, "kilo.polkavm")],
      ["home/readme.txt", join(fixture, "readme.txt")],
    ].map(async ([name, path]) => {
      const bytes = new Uint8Array(await readFile(path));
      const cid = CID.createV1(raw.code, await sha256.digest(bytes));
      return { name, bytes, cid };
    }),
  );
  const manifestBytes = files[0].bytes;
  const links: PBLink[] = files
    .map(({ name, bytes, cid }) => ({
      Name: name,
      Tsize: bytes.length,
      Hash: cid,
    }))
    .sort((left, right) => (left.Name ?? "").localeCompare(right.Name ?? ""));
  const rootBytes = dagPb.encode({
    Data: new UnixFS({ type: "directory" }).marshal(),
    Links: links,
  });
  const root = CID.createV1(dagPb.code, await sha256.digest(rootBytes));
  const { writer, out } = CarWriter.create([root]);
  const chunksPromise = (async (): Promise<Uint8Array[]> => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of out) chunks.push(chunk);
    return chunks;
  })();
  for (const { cid, bytes } of files) await writer.put({ cid, bytes });
  await writer.put({ cid: root, bytes: rootBytes });
  await writer.close();
  const chunks = await chunksPromise;
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const car = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    car.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    cid: root.toString(),
    bytes: car,
    manifest: new TextDecoder().decode(manifestBytes),
  };
}

async function mountComputer(
  page: Page,
  fixture: ComputerFixture,
  fullReset: boolean,
): Promise<FrameLocator> {
  await page.evaluate(
    ({ cid, executableManifest, schemaVersion, reset }) => {
      const url = new URL(
        `http://computer-fixture.app.localhost:5173/?cid=${cid}&v=${String(schemaVersion)}&chainBackend=rpc-gateway&network=paseo-next-v2`,
      );
      url.searchParams.set("executableManifest", executableManifest);
      if (reset) {
        url.searchParams.set("fullReset", "1");
      }
      const iframe = document.createElement("iframe");
      iframe.id = "computer-product";
      iframe.style.width = "100vw";
      iframe.style.height = "100vh";
      iframe.src = url.toString();
      document.body.replaceChildren(iframe);
    },
    {
      cid: fixture.cid,
      executableManifest: fixture.manifest,
      schemaVersion: SANDBOX_SCHEMA_VERSION,
      reset: fullReset,
    },
  );
  return page.frameLocator("#computer-product");
}

async function screenText(product: FrameLocator): Promise<string> {
  return (await product.locator("#dotli-computer-screen").textContent()) ?? "";
}

test("a PolkaVM computer boots a shell, edits with a child VM, and persists /home", async ({
  page,
}) => {
  const fixture = await computerCar();
  await page.route(`**/ipfs/${fixture.cid}?format=car`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.ipld.car",
      body: Buffer.from(fixture.bytes),
    });
  });
  await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
  const product = await mountComputer(page, fixture, true);
  const screen = product.locator("#dotli-computer-screen");
  await expect(screen).toHaveAttribute("data-computer-ready", "true", {
    timeout: 60_000,
  });
  await expect
    .poll(async () => screenText(product))
    .toContain("PolkaVM computer shell");

  // The archive's home/ tree is mounted at /home.
  await screen.click();
  await page.keyboard.type("ls");
  await page.keyboard.press("Enter");
  await expect.poll(async () => screenText(product)).toContain("readme.txt");
  await page.keyboard.type("cat readme.txt");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => screenText(product))
    .toContain("hello from the archive seed");

  // kilo runs as a spawned child VM; save, quit, and verify from the shell.
  await page.keyboard.type("kilo notes.txt");
  await page.keyboard.press("Enter");
  await expect.poll(async () => screenText(product)).toContain("HELP: Ctrl-S");
  await page.keyboard.type("computer on the web");
  await page.keyboard.press("Control+s");
  await expect
    .poll(async () => screenText(product))
    .toContain("bytes written on disk");
  await page.keyboard.press("Control+q");
  await page.keyboard.type("cat notes.txt");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => screenText(product))
    .toContain("computer on the web");

  // Persistence: reload the product frame; the save record restores /home.
  const productFrame = page
    .frames()
    .find((frame) => frame.url().includes("computer-fixture.app.localhost"));
  if (productFrame === undefined) {
    throw new Error("computer product frame did not mount");
  }
  await Promise.all([
    productFrame.waitForNavigation({ waitUntil: "domcontentloaded" }),
    productFrame.evaluate(() => {
      window.location.reload();
    }),
  ]);
  await expect(screen).toHaveAttribute("data-computer-ready", "true", {
    timeout: 60_000,
  });
  await screen.click();
  await page.keyboard.type("cat notes.txt");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => screenText(product))
    .toContain("computer on the web");
});
