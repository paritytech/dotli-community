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
import {
  decodeWireMessage,
  encodeWireMessage,
  RemotePermissionResponse,
  VersionedRemotePermissionError,
  VersionedRemotePermissionRequest,
} from "@parity/truapi";
import { CallError, Result, indexedTaggedUnion } from "@parity/truapi/scale";
import { PERMISSIONS_REQUEST_REMOTE_PERMISSION } from "@parity/truapi/wire-table";

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

// Stand-in for the dotli Host core: answer the sandbox's `truapi-ready`
// announcement with a MessagePort and grant every RemotePermission request,
// recording the requested domains. In production `packages/ui/src/bridge.ts`
// wires this port to the Rust core, which shows the permission modal.
async function grantRemotePermissions(page: Page): Promise<string[]> {
  const domains: string[] = [];
  const remoteResponse = indexedTaggedUnion({
    V1: [
      0,
      Result(
        RemotePermissionResponse,
        CallError(VersionedRemotePermissionError),
      ),
    ],
  });
  await page.exposeFunction(
    "__truapiGrantRemote",
    (bytes: number[]): number[] | null => {
      const decoded = decodeWireMessage(new Uint8Array(bytes));
      if (decoded.isErr()) return null;
      const { requestId, payload } = decoded.value;
      if (payload.id !== PERMISSIONS_REQUEST_REMOTE_PERMISSION.request) {
        return null;
      }
      const request = VersionedRemotePermissionRequest.dec(payload.value).value;
      if (request.permission.tag === "Remote") {
        domains.push(...request.permission.value.domains);
      }
      const encoded = encodeWireMessage({
        requestId,
        payload: {
          id: PERMISSIONS_REQUEST_REMOTE_PERMISSION.response,
          value: remoteResponse.enc({
            tag: "V1",
            value: { success: true, value: { granted: true } },
          }),
        },
      });
      return encoded.isOk() ? Array.from(encoded.value) : null;
    },
  );
  await page.evaluate(() => {
    window.addEventListener("message", (event) => {
      const data: unknown = event.data;
      if (
        data === null ||
        typeof data !== "object" ||
        !("type" in data) ||
        data.type !== "truapi-ready"
      ) {
        return;
      }
      if (event.source === null) return;
      // The product iframe is cross-origin, so event.source is a restricted
      // WindowProxy: `instanceof Window` is unreliable; trust the protocol.
      const source = event.source as Window;
      // exposeFunction installs the binding on window; the DOM lib has no
      // declaration for it, so narrow through a named holder once.
      const holder = window as Window & {
        __truapiGrantRemote?: (bytes: number[]) => Promise<number[] | null>;
      };
      const grant = holder.__truapiGrantRemote;
      if (grant === undefined) return;
      const channel = new MessageChannel();
      channel.port1.onmessage = async (message) => {
        if (!(message.data instanceof Uint8Array)) return;
        const reply = await grant(Array.from(message.data));
        if (reply !== null) channel.port1.postMessage(new Uint8Array(reply));
      };
      source.postMessage({ type: "truapi-init" }, "*", [channel.port2]);
    });
  });
  return domains;
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

test("a network computer open-spawns Lynx by published name", async ({
  page,
}) => {
  const computer = await appCar([
    ["manifest.json", "network-manifest.json"],
    ["shell.polkavm", "shell.polkavm"],
    ["home/readme.txt", "readme.txt"],
  ]);
  const lynx = await appCar([
    ["manifest.json", "lynx-manifest.json"],
    ["app.polkavm", "lynx.polkavm"],
    ["home/cacert.pem", "lynx-cacert.pem"],
    ["home/lynx.cfg", "lynx.cfg"],
    ["home/lynx.lss", "lynx.lss"],
    ["home/index.html", "lynx-index.html"],
  ]);
  await routeCar(page, computer);
  await routeCar(page, lynx);
  await page.goto("http://localhost:5173/", {
    waitUntil: "domcontentloaded",
  });
  await answerResolutions(page, {
    lynx: { cid: lynx.cid, manifest: lynx.manifest },
  });
  const product = await mountComputer(
    page,
    computer,
    true,
    "lynx-child-fixture",
  );
  const screen = product.locator("#dotli-computer-screen");
  await expect(screen).toHaveAttribute("data-computer-ready", "true", {
    timeout: 60_000,
  });
  await screen.click();
  await page.keyboard.type("lynx");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => screenText(product), { timeout: 60_000 })
    .toContain("PolkaVM Lynx");
});

test("Lynx browses HTTPS through the guest TLS stack", async ({ page }) => {
  const lynx = await appCar([
    ["manifest.json", "lynx-manifest.json"],
    ["app.polkavm", "lynx.polkavm"],
    ["home/cacert.pem", "lynx-cacert.pem"],
    ["home/lynx.cfg", "lynx.cfg"],
    ["home/lynx.lss", "lynx.lss"],
    ["home/index.html", "lynx-index.html"],
  ]);
  await routeCar(page, lynx);
  await page.goto("http://localhost:5173/", {
    waitUntil: "domcontentloaded",
  });
  // The functional harness has no dotli bridge; stand in for the Host core
  // and grant the sandbox's remote-permission request while recording it.
  const requestedDomains = await grantRemotePermissions(page);
  const product = await mountComputer(page, lynx, true, "lynx-fixture");
  const screen = product.locator("#dotli-computer-screen");
  await expect(screen).toHaveAttribute("data-computer-ready", "true", {
    timeout: 60_000,
  });
  await expect
    .poll(async () => screenText(product))
    .toContain("H)elp O)ptions");

  await screen.click();
  await page.keyboard.type("g");
  await expect.poll(async () => screenText(product)).toContain("URL to open");
  await page.keyboard.type("https://example.com/");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => screenText(product), { timeout: 60_000 })
    .toContain("Example Domain");
  // The connection only proceeds after the sandbox asked the Host for the
  // exact domain; dotli's bridge turns this request into a user prompt.
  expect(requestedDomains).toEqual(["example.com"]);
});

test("a network app boots even when no TCP relay is granted", async ({
  page,
}) => {
  // Contract: requiring polkadot-host/0.1/net never gates booting. When the
  // build has no VITE_PVM_TCP_RELAY_URL the sandbox clamps networking off and
  // TCP hostcalls return DENIED; the terminal still works. This test asserts
  // only relay-independent behavior so it passes on both build flavors.
  const lynx = await appCar([
    ["manifest.json", "lynx-manifest.json"],
    ["app.polkavm", "lynx.polkavm"],
    ["home/cacert.pem", "lynx-cacert.pem"],
    ["home/lynx.cfg", "lynx.cfg"],
    ["home/lynx.lss", "lynx.lss"],
    ["home/index.html", "lynx-index.html"],
  ]);
  await routeCar(page, lynx);
  await page.goto("http://localhost:5173/", {
    waitUntil: "domcontentloaded",
  });
  const product = await mountComputer(page, lynx, true, "lynx-offline");
  const screen = product.locator("#dotli-computer-screen");
  await expect(screen).toHaveAttribute("data-computer-ready", "true", {
    timeout: 60_000,
  });
  await expect
    .poll(async () => screenText(product))
    .toContain("H)elp O)ptions");

  // A connect attempt is refused (no relay, or no permission grant when a
  // relay exists) without killing the computer. Lynx's failure alert is a
  // transient status line, so assert the stable outcome instead: the event
  // loop survives and reopens the URL prompt on demand. The 30s poll
  // outlasts the sandbox's 10s TrUAPI permission-port timeout.
  await screen.click();
  await page.keyboard.type("g");
  await expect.poll(async () => screenText(product)).toContain("URL to open");
  await page.keyboard.type("https://example.com/");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () => {
        const text = await screenText(product);
        if (text.includes("URL to open")) {
          return text;
        }
        // Denied and redrawn to the main screen: ask for the prompt again.
        await page.keyboard.type("g");
        return screenText(product);
      },
      { timeout: 30_000 },
    )
    .toContain("URL to open");
  await expect(screen).not.toHaveAttribute("data-computer-exit");
});

test("a workspace app tiles independently sandboxed shell panes", async ({
  page,
}) => {
  // The ADR's third proof: one .pvm workspace application launches multiple
  // independent child PVM computers, tiles their terminal surfaces, and
  // routes input to the focused pane. Bindings are tmux-style Ctrl-B.
  const workspace = await appCar([
    ["manifest.json", "workspace-manifest.json"],
    ["workspace.polkavm", "workspace.polkavm"],
    ["packages/shell.polkavm", "shell.polkavm"],
  ]);
  const kilo = await appCar([
    ["manifest.json", "kilo-manifest.json"],
    ["kilo.polkavm", "kilo.polkavm"],
  ]);
  await routeCar(page, workspace);
  await routeCar(page, kilo);
  await page.goto("http://localhost:5173/", {
    waitUntil: "domcontentloaded",
  });
  // kilo is NOT bundled in the workspace archive: the pane's shell resolves
  // it as a published app through the host bridge (open spawn).
  await answerResolutions(page, {
    kilo: { cid: kilo.cid, manifest: kilo.manifest },
  });
  const product = await mountComputer(page, workspace, true, "ws-fixture");
  const screen = product.locator("#dotli-computer-screen");
  await expect(screen).toHaveAttribute("data-computer-ready", "true", {
    timeout: 60_000,
  });
  // The workspace draws its status bar before any pane exists.
  await expect.poll(async () => screenText(product)).toContain("C-b");

  // Spawn three shell panes; the status bar tracks count and focus.
  await screen.click();
  for (let pane = 1; pane <= 3; pane += 1) {
    await page.keyboard.press("Control+b");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => screenText(product), { timeout: 30_000 })
      .toContain(`[${String(pane)}:shell`);
  }
  // Each pane is a real shell child rendering into its tile.
  await expect
    .poll(async () => screenText(product), { timeout: 30_000 })
    .toContain("PolkaVM computer shell");

  // Input routes to the focused pane only.
  await page.keyboard.type("help");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => screenText(product), { timeout: 30_000 })
    .toContain("ls");

  // Any published app runs inside a pane without being declared in the
  // workspace manifest: the pane shell open-spawns kilo, which suspends
  // the tree until the page resolves the label through the host bridge.
  await page.keyboard.type("kilo notes.txt");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => screenText(product), { timeout: 60_000 })
    .toContain("HELP: Ctrl-S");
  await page.keyboard.type("resolved inside a pane");
  await page.keyboard.press("Control+s");
  await expect
    .poll(async () => screenText(product), { timeout: 30_000 })
    .toContain("bytes written on disk");
  await page.keyboard.press("Control+q");
  await expect
    .poll(async () => screenText(product), { timeout: 30_000 })
    .toContain("PolkaVM computer shell");

  // Close the focused pane; the layout retiles down to two.
  await page.keyboard.press("Control+b");
  await page.keyboard.type("x");
  await expect
    .poll(async () => screenText(product), { timeout: 30_000 })
    .not.toContain("[3:shell");

  // Quit the workspace; the computer exits cleanly.
  await page.keyboard.press("Control+b");
  await page.keyboard.type("q");
  await expect(screen).toHaveAttribute("data-computer-exit", "0", {
    timeout: 30_000,
  });
});

test("a workspace pane open-spawns Lynx with its seed files", async ({
  page,
}) => {
  // Seed-propagation proof: Lynx's home/ seeds (lynx.cfg, cacert.pem,
  // index.html) arrive at resolution time — AFTER the pane spawned. The
  // supervisor forwards live mounts to every child, so the already-running
  // pane sees them; without that, Lynx reports its configuration file
  // missing and never fetches the startfile.
  const workspace = await appCar([
    ["manifest.json", "workspace-net-manifest.json"],
    ["workspace.polkavm", "workspace.polkavm"],
    ["packages/shell.polkavm", "shell.polkavm"],
  ]);
  const lynx = await appCar([
    ["manifest.json", "lynx-manifest.json"],
    ["app.polkavm", "lynx.polkavm"],
    ["home/cacert.pem", "lynx-cacert.pem"],
    ["home/lynx.cfg", "lynx.cfg"],
    ["home/lynx.lss", "lynx.lss"],
    ["home/index.html", "lynx-index.html"],
  ]);
  await routeCar(page, workspace);
  await routeCar(page, lynx);
  await page.goto("http://localhost:5173/", {
    waitUntil: "domcontentloaded",
  });
  await answerResolutions(page, {
    lynx: { cid: lynx.cid, manifest: lynx.manifest },
  });
  const requestedDomains = await grantRemotePermissions(page);
  const product = await mountComputer(page, workspace, true, "ws-lynx");
  const screen = product.locator("#dotli-computer-screen");
  await expect(screen).toHaveAttribute("data-computer-ready", "true", {
    timeout: 60_000,
  });
  await expect.poll(async () => screenText(product)).toContain("C-b");

  await screen.click();
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => screenText(product), { timeout: 30_000 })
    .toContain("PolkaVM computer shell");

  // The pane shell resolves Lynx as a published app. Its home/ seeds are
  // mounted at resolution time — after the pane spawned — so the greeting
  // (from the seeded index.html) rendering inside the pane proves live
  // parent->child mount propagation.
  await page.keyboard.type("lynx");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => screenText(product), { timeout: 60_000 })
    .toContain("PolkaVM Lynx");

  // Browsing HTTPS exercises the remaining seeds and the whole chain
  // inside a pane: cacert.pem for guest TLS, the permission grant, and
  // the TCP relay.
  await page.keyboard.type("g");
  await expect
    .poll(async () => screenText(product), { timeout: 30_000 })
    .toContain("URL to open");
  await page.keyboard.type("https://example.com/");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => screenText(product), { timeout: 60_000 })
    .toContain("Example Domain");
  expect(requestedDomains).toEqual(["example.com"]);
});
