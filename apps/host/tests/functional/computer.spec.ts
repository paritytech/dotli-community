// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Functional coverage for the experimental `polkadot-host` computer app
// kind: a real shell guest boots in the sandbox terminal, spawns the kilo
// editor via OPEN SPAWN (kilo is its own published app, resolved by name
// through the host bridge — it is deliberately absent from the computer's
// manifest), and /home persists across reloads.

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

interface AppCar {
  cid: string;
  bytes: Uint8Array;
  manifest: string;
}

const fixtureRoot = join(import.meta.dirname, "fixtures/pvm-computer");

async function appCar(entries: readonly string[][]): Promise<AppCar> {
  const files = await Promise.all(
    entries.map(async ([name, path]) => {
      const bytes = new Uint8Array(await readFile(join(fixtureRoot, path)));
      const cid = CID.createV1(raw.code, await sha256.digest(bytes));
      return { name, bytes, cid };
    }),
  );
  const manifestBytes = files.find(
    (file) => file.name === "manifest.json",
  )?.bytes;
  if (manifestBytes === undefined) {
    throw new Error("fixture archive is missing manifest.json");
  }
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

async function routeCar(page: Page, fixture: AppCar): Promise<void> {
  await page.route(`**/ipfs/${fixture.cid}?format=car`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.ipld.car",
      body: Buffer.from(fixture.bytes),
    });
  });
}

// The test page is the sandbox iframe's parent, standing in for the dot.li
// host shell: it answers open-spawn resolutions exactly like
// listenForComputerResolutions does in production.
async function answerResolutions(
  page: Page,
  apps: Record<string, { cid: string; manifest: string }>,
): Promise<void> {
  await page.evaluate((published) => {
    window.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        label?: string;
        nonce?: string;
      } | null;
      if (
        data?.type !== "dotli:computer-resolve-app" ||
        typeof data.label !== "string" ||
        typeof data.nonce !== "string" ||
        event.source === null
      ) {
        return;
      }
      const app = published[data.label] as
        | { cid: string; manifest: string }
        | undefined;
      const reply =
        app === undefined
          ? {
              type: "dotli:computer-app-error",
              nonce: data.nonce,
              message: `no app published at ${data.label}`,
            }
          : {
              type: "dotli:computer-app",
              nonce: data.nonce,
              cid: app.cid,
              executableManifest: app.manifest,
            };
      (event.source as Window).postMessage(reply, "*");
    });
  }, apps);
}

async function mountComputer(
  page: Page,
  fixture: AppCar,
  fullReset: boolean,
  label = "computer-fixture",
): Promise<FrameLocator> {
  await page.evaluate(
    ({ cid, executableManifest, schemaVersion, reset, appLabel }) => {
      const url = new URL(
        `http://${appLabel}.app.localhost:5173/?cid=${cid}&v=${String(schemaVersion)}&chainBackend=rpc-gateway&network=paseo-next-v2`,
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
      appLabel: label,
    },
  );
  return page.frameLocator("#computer-product");
}

async function screenText(product: FrameLocator): Promise<string> {
  return (await product.locator("#dotli-computer-screen").textContent()) ?? "";
}

test("a PolkaVM computer open-spawns a published editor and persists /home", async ({
  page,
}) => {
  const computer = await appCar([
    ["manifest.json", "manifest.json"],
    ["shell.polkavm", "shell.polkavm"],
    ["home/readme.txt", "readme.txt"],
  ]);
  const kilo = await appCar([
    ["manifest.json", "kilo-manifest.json"],
    ["kilo.polkavm", "kilo.polkavm"],
  ]);
  await routeCar(page, computer);
  await routeCar(page, kilo);
  await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
  await answerResolutions(page, {
    kilo: { cid: kilo.cid, manifest: kilo.manifest },
  });
  const product = await mountComputer(page, computer, true);
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

  // kilo is NOT in the computer's manifest: the spawn suspends, the page
  // resolves the label through the host bridge, fetches and verifies the
  // kilo app archive, and the editor runs as a sandboxed child VM.
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

  // An unpublished label fails the spawn; the shell survives and reports it.
  await page.keyboard.type("vi ghost.txt");
  await page.keyboard.press("Enter");
  await expect.poll(async () => screenText(product)).toContain("vi");
  await page.keyboard.type("ls");
  await page.keyboard.press("Enter");
  await expect.poll(async () => screenText(product)).toContain("notes.txt");
});

test("Vim runs as a standalone published computer app", async ({ page }) => {
  const vim = await appCar([
    ["manifest.json", "vim-manifest.json"],
    ["vim.polkavm", "vim.polkavm"],
  ]);
  await routeCar(page, vim);
  await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
  const product = await mountComputer(page, vim, true, "vim-fixture");
  const screen = product.locator("#dotli-computer-screen");
  await expect(screen).toHaveAttribute("data-computer-ready", "true", {
    timeout: 60_000,
  });
  await expect.poll(async () => screenText(product)).toContain("~");

  await screen.click();
  await page.keyboard.type("iVim standalone works");
  await page.keyboard.press("Escape");
  await page.keyboard.type(":w /home/standalone.txt");
  await page.keyboard.press("Enter");
  await expect.poll(async () => screenText(product)).toContain("bytes written");
  // The compact terminal triggers Vim's normal hit-enter wait.
  await page.keyboard.press("Enter");
  await page.keyboard.type(":q");
  await page.keyboard.press("Enter");
  await expect(screen).toHaveAttribute("data-computer-exit", "0", {
    timeout: 30_000,
  });
});

test("Kilo runs as a standalone published computer app", async ({ page }) => {
  const kilo = await appCar([
    ["manifest.json", "kilo-manifest.json"],
    ["kilo.polkavm", "kilo.polkavm"],
  ]);
  await routeCar(page, kilo);
  await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
  const product = await mountComputer(page, kilo, true, "kilo-fixture");
  const screen = product.locator("#dotli-computer-screen");
  await expect(screen).toHaveAttribute("data-computer-ready", "true", {
    timeout: 60_000,
  });
  await expect.poll(async () => screenText(product)).toContain("HELP: Ctrl-S");

  await screen.click();
  await page.keyboard.type("Kilo standalone works");
  await page.keyboard.press("Control+s");
  await expect
    .poll(async () => screenText(product))
    .toContain("bytes written on disk");
  await page.keyboard.press("Control+q");
  await expect(screen).toHaveAttribute("data-computer-exit", "0", {
    timeout: 30_000,
  });
});
