// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Boot path for the experimental `polkadot-host-computer/0.1` contract.
// A computer package is a shell program plus optional child packages; the
// supervisor (and every VM) runs inside pvm-computer-worker.js, while this
// module owns the DOM terminal, keyboard routing, and /home persistence.

import type { ArchiveFiles } from "@dotli/content/archive";
import {
  createClient,
  createMessagePortProvider,
  createTransport,
  type TrUApiClient,
} from "@parity/truapi";
import {
  ComputerTerminal,
  keyEventToBytes,
  type TerminalSnapshot,
} from "./computer-terminal";
import { waitForTruapiPort } from "./pvm-runtime";

const PVM_RUNTIME_ROOT = "/pvm-runtime";
const MAX_PROGRAM_BYTES = 16 * 1024 * 1024;
const MAX_SAVE_BYTES = 64 * 1024 * 1024 + 128 * 1024;
const SAVE_DB_NAME = "dotli-pvm";
const SAVE_DB_VERSION = 2;
const SAVE_STORE = "saves";
const SAVE_FORMAT_VERSION = 2;
const HOME_PREFIX = "home/";
const MAX_GAS = 8_000_000_000;
const TCP_RELAY_URL =
  (import.meta.env.VITE_PVM_TCP_RELAY_URL as string | undefined)?.trim() ?? "";
const RESIZE_DEBOUNCE_MS = 200;
const MIN_COLUMNS = 20;
const MAX_COLUMNS = 240;
const MIN_ROWS = 6;
const MAX_ROWS = 100;
const RESOLVE_TIMEOUT_MS = 30_000;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

// Interfaces this sandbox host provides; ids per the runtime ADR namespace.
const HOST_INTERFACES: readonly string[] = [
  "polkadot-host/0.1/core",
  "polkadot-host/0.1/fs",
  "polkadot-host/0.1/tty",
  "polkadot-host/0.1/process",
  "polkadot-host/0.1/net",
  "polkadot-host/0.1/workspace",
];
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

interface ComputerDescriptor {
  programPath: string;
  packages: { name: string; path: string }[];
  networkEnabled: boolean;
  workspaceEnabled: boolean;
}

interface WorkerFileEntry {
  path: string;
  bytes: Uint8Array;
}

interface FilesystemMetadata {
  version: 1;
  nextInode: string;
  clockNs: string;
  entries: {
    path: string;
    kind: 1 | 2;
    mtimeNs: string;
    inode: string;
  }[];
}

interface SavedFilesystem {
  files: Map<string, Uint8Array>;
  metadata: FilesystemMetadata | null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanPath(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.startsWith("/") ||
    value.includes("\\")
  ) {
    return null;
  }
  const path = value;
  const parts = path.split("/");
  return parts.some((part) => part === "" || part === "." || part === "..")
    ? null
    : path;
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return bytes;
}

function assertExternalManifest(
  embedded: Uint8Array,
  externalManifest: string | null,
): void {
  if (externalManifest === null) {
    throw new Error("PolkaVM computer requires an executable manifest record");
  }
  const external = encoder.encode(externalManifest);
  if (
    external.byteLength !== embedded.byteLength ||
    external.some((byte, index) => byte !== embedded[index])
  ) {
    throw new Error(
      "embedded App manifest does not match the external executable record",
    );
  }
}

function parseComputerManifest(
  files: ArchiveFiles,
  externalManifest: string | null,
  enforceExternal: boolean,
): ComputerDescriptor | null {
  if (!Object.hasOwn(files, "manifest.json")) {
    return null;
  }
  const bytes = files["manifest.json"];
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  const manifest = object(value);
  const runtime = object(manifest?.runtime);
  if (runtime?.kind !== "polkavm") {
    return null;
  }
  const capabilities = object(manifest?.capabilities);
  // The required host interfaces ARE the contract declaration: manifests
  // without capabilities.host belong to the cooperative graphics runtime.
  if (capabilities?.host === undefined) {
    return null;
  }
  if (manifest?.$v !== 2 || manifest.kind !== "app") {
    throw new Error("PolkaVM computer manifests must be App manifest v2");
  }
  if (runtime.abiVersion !== undefined) {
    throw new Error("host-interface apps must not declare runtime.abiVersion");
  }
  const programPath = cleanPath(runtime.entrypoint);
  if (programPath?.endsWith(".polkavm") !== true) {
    throw new Error("PolkaVM computer has an invalid runtime entrypoint");
  }
  const host = object(capabilities.host);
  const requires = Array.isArray(host?.requires) ? host.requires : null;
  if (
    requires === null ||
    requires.length === 0 ||
    new Set(requires).size !== requires.length ||
    requires.some((id) => typeof id !== "string") ||
    !requires.includes("polkadot-host/0.1/core")
  ) {
    throw new Error("PolkaVM computer must require polkadot-host interfaces");
  }
  // Fail closed: refuse any manifest requiring an interface this host
  // cannot provide, before a single guest instruction runs.
  for (const id of requires) {
    if (!HOST_INTERFACES.includes(id as string)) {
      throw new Error(`unsupported host interface ${JSON.stringify(id)}`);
    }
  }
  if (
    capabilities.graphics !== undefined ||
    capabilities.deviceInput !== undefined ||
    capabilities.audio !== undefined ||
    capabilities.terminal !== undefined
  ) {
    throw new Error("host apps declare interfaces, not device capabilities");
  }
  const packages: { name: string; path: string }[] = [];
  if (capabilities.packages !== undefined) {
    if (!Array.isArray(capabilities.packages)) {
      throw new Error("PolkaVM computer packages must be an array");
    }
    const seen = new Set<string>();
    for (const entryValue of capabilities.packages) {
      const entry = object(entryValue);
      const name = entry?.name;
      const path = cleanPath(entry?.path);
      if (
        typeof name !== "string" ||
        !PACKAGE_NAME.test(name) ||
        seen.has(name) ||
        path?.endsWith(".polkavm") !== true ||
        path === programPath
      ) {
        throw new Error("PolkaVM computer declares an invalid package");
      }
      seen.add(name);
      packages.push({ name, path });
    }
  }
  if (enforceExternal) {
    assertExternalManifest(bytes, externalManifest);
  }
  return {
    programPath,
    packages,
    networkEnabled: requires.includes("polkadot-host/0.1/net"),
    workspaceEnabled: requires.includes("polkadot-host/0.1/workspace"),
  };
}

export function isComputerPackage(files: ArchiveFiles): boolean {
  return parseComputerManifest(files, null, false) !== null;
}

function validateComputerFiles(
  files: ArchiveFiles,
  descriptor: ComputerDescriptor,
): void {
  for (const path of [
    descriptor.programPath,
    ...descriptor.packages.map((entry) => entry.path),
  ]) {
    const program = files[path] as Uint8Array | undefined;
    if (program === undefined) {
      throw new Error(`PolkaVM computer package is missing ${path}`);
    }
    if (program.byteLength === 0 || program.byteLength > MAX_PROGRAM_BYTES) {
      throw new Error(`PolkaVM computer program ${path} has an invalid size`);
    }
  }
}

// ---------------------------------------------------------------------------
// /home persistence: one atomic IndexedDB record containing file bytes and
// namespace metadata. Version 1 byte-only records migrate on the next save.
// The key namespace ("computer") keeps these apart from cartridge saves.

function encodeFilesystem(
  files: Map<string, Uint8Array>,
  metadata: FilesystemMetadata,
): Uint8Array | null {
  const metadataBytes = encoder.encode(JSON.stringify(metadata));
  let total = 5 + metadataBytes.byteLength;
  for (const [path, bytes] of files) {
    total += 8 + encoder.encode(path).byteLength + bytes.byteLength;
  }
  if (total > MAX_SAVE_BYTES) {
    return null;
  }
  const record = new Uint8Array(total);
  const view = new DataView(record.buffer);
  record[0] = SAVE_FORMAT_VERSION;
  view.setUint32(1, metadataBytes.byteLength, true);
  record.set(metadataBytes, 5);
  let offset = 5 + metadataBytes.byteLength;
  for (const [path, bytes] of files) {
    const pathBytes = encoder.encode(path);
    view.setUint32(offset, pathBytes.byteLength, true);
    record.set(pathBytes, offset + 4);
    offset += 4 + pathBytes.byteLength;
    view.setUint32(offset, bytes.byteLength, true);
    record.set(bytes, offset + 4);
    offset += 4 + bytes.byteLength;
  }
  return record;
}

function decodeFilesystem(record: Uint8Array): SavedFilesystem {
  const files = new Map<string, Uint8Array>();
  if (record.byteLength === 0) {
    return { files, metadata: null };
  }
  const version = record[0];
  if (version !== 1 && version !== SAVE_FORMAT_VERSION) {
    throw new Error("unsupported computer filesystem save version");
  }
  const view = new DataView(
    record.buffer,
    record.byteOffset,
    record.byteLength,
  );
  let offset = 1;
  let metadata: FilesystemMetadata | null = null;
  const readBytes = (): Uint8Array => {
    if (offset + 4 > record.byteLength) {
      throw new Error("truncated computer filesystem save");
    }
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length > record.byteLength - offset) {
      throw new Error("truncated computer filesystem save");
    }
    const bytes = record.subarray(offset, offset + length);
    offset += length;
    return bytes;
  };
  if (version === SAVE_FORMAT_VERSION) {
    const value: unknown = JSON.parse(decoder.decode(readBytes()));
    const candidate = object(value);
    if (
      candidate?.version !== 1 ||
      typeof candidate.nextInode !== "string" ||
      typeof candidate.clockNs !== "string" ||
      !Array.isArray(candidate.entries)
    ) {
      throw new Error("invalid computer filesystem metadata");
    }
    // The runtime validates every path, inode, timestamp and file/directory
    // relation atomically before starting the guest.
    metadata = value as FilesystemMetadata;
  }
  while (offset < record.byteLength) {
    const path = decoder.decode(readBytes());
    const bytes = readBytes();
    if (files.has(path)) {
      throw new Error("duplicate path in computer filesystem save");
    }
    files.set(path, ownedBytes(bytes));
  }
  return { files, metadata };
}

function openSaveDb(): Promise<IDBDatabase> {
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const request = indexedDB.open(SAVE_DB_NAME, SAVE_DB_VERSION);
  request.onerror = () => {
    reject(request.error ?? new Error("save DB failed"));
  };
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(SAVE_STORE)) {
      request.result.createObjectStore(SAVE_STORE);
    }
  };
  request.onsuccess = () => {
    resolve(request.result);
  };
  return promise;
}

async function loadSave(key: string): Promise<Uint8Array | null> {
  const db = await openSaveDb();
  try {
    const transaction = db.transaction(SAVE_STORE, "readonly");
    const request = transaction.objectStore(SAVE_STORE).get(key);
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("save read failed"));
    };
    const value = await promise;
    if (value === undefined) {
      return null;
    }
    if (!(value instanceof ArrayBuffer) || value.byteLength > MAX_SAVE_BYTES) {
      throw new Error("invalid computer filesystem save");
    }
    return new Uint8Array(value);
  } finally {
    db.close();
  }
}

async function storeSave(key: string, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SAVE_BYTES) {
    throw new Error("computer filesystem save exceeds its size limit");
  }
  const db = await openSaveDb();
  try {
    const transaction = db.transaction(SAVE_STORE, "readwrite");
    transaction.objectStore(SAVE_STORE).put(ownedBytes(bytes).buffer, key);
    const { promise, resolve, reject } = Promise.withResolvers<undefined>();
    transaction.oncomplete = () => {
      resolve(undefined);
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("save write failed"));
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error("save transaction aborted"));
    };
    await promise;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// DOM terminal shell.

interface ComputerShell {
  screen: HTMLPreElement;
  status: HTMLElement;
}

function createComputerShell(): ComputerShell {
  const style = document.createElement("style");
  style.textContent = `
    html,body{width:100%;height:100%;margin:0;background:#0b0e11;overflow:hidden}
    #dotli-computer-shell{width:100%;height:100%;position:relative;display:flex;padding:10px;box-sizing:border-box}
    #dotli-computer-screen{flex:1;margin:0;outline:none;overflow:hidden;font:14px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;cursor:text}
    .dotli-computer-overlay{position:absolute;left:12px;background:#090b0de8;border:1px solid #ffffff2b;border-radius:4px;font:11px/1.35 ui-monospace,monospace;color:#f5f5f5}
    #dotli-computer-status{top:12px;padding:5px 8px;pointer-events:none;z-index:1}
    #dotli-computer-status:empty{display:none}
  `;
  const shell = document.createElement("main");
  shell.id = "dotli-computer-shell";
  const screen = document.createElement("pre");
  screen.id = "dotli-computer-screen";
  screen.tabIndex = 0;
  const status = document.createElement("div");
  status.id = "dotli-computer-status";
  status.className = "dotli-computer-overlay";
  status.textContent = "Translating PolkaVM computer…";
  shell.append(screen, status);
  document.head.append(style);
  document.body.replaceChildren(shell);
  return { screen, status };
}

function measureCell(screen: HTMLPreElement): {
  width: number;
  height: number;
} {
  const probe = document.createElement("span");
  probe.textContent = "M".repeat(10);
  probe.style.visibility = "hidden";
  screen.append(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  return { width: rect.width / 10, height: rect.height };
}

function terminalGeometry(screen: HTMLPreElement): {
  columns: number;
  rows: number;
} {
  const cell = measureCell(screen);
  const rect = screen.getBoundingClientRect();
  const columns = Math.min(
    MAX_COLUMNS,
    Math.max(MIN_COLUMNS, Math.floor(rect.width / cell.width)),
  );
  const rows = Math.min(
    MAX_ROWS,
    Math.max(MIN_ROWS, Math.floor(rect.height / cell.height)),
  );
  return { columns, rows };
}

function renderSnapshot(
  screen: HTMLPreElement,
  snapshot: TerminalSnapshot,
): void {
  const fragment = document.createDocumentFragment();
  for (let row = 0; row < snapshot.rows; row += 1) {
    let spanText = "";
    let spanStyle: string | null = null;
    const flush = (): void => {
      if (spanText === "") {
        return;
      }
      const span = document.createElement("span");
      span.textContent = spanText;
      if (spanStyle !== null && spanStyle !== "") {
        span.setAttribute("style", spanStyle);
      }
      fragment.append(span);
      spanText = "";
    };
    for (let column = 0; column < snapshot.columns; column += 1) {
      const cell = snapshot.cells[row * snapshot.columns + column];
      const cursorHere =
        snapshot.cursorVisible &&
        row === snapshot.cursorRow &&
        column === snapshot.cursorColumn;
      const inverse = cell.inverse !== cursorHere;
      const foreground = inverse ? cell.background : cell.foreground;
      const background = inverse ? cell.foreground : cell.background;
      const style = `color:#${foreground.toString(16).padStart(6, "0")};background:#${background.toString(16).padStart(6, "0")}${cell.bold ? ";font-weight:700" : ""}`;
      if (style !== spanStyle) {
        flush();
        spanStyle = style;
      }
      spanText += cell.character;
    }
    flush();
    if (row + 1 < snapshot.rows) {
      fragment.append("\n");
    }
  }
  screen.replaceChildren(fragment);
}

// ---------------------------------------------------------------------------
// Boot.

export async function runComputerApplication(
  files: ArchiveFiles,
  cid: string,
  externalManifest: string | null = null,
): Promise<void> {
  const descriptor = parseComputerManifest(files, externalManifest, true);
  if (descriptor === null) {
    throw new Error("package is not a PolkaVM computer");
  }
  // Permission prompts route through the product's TrUAPI connection. Resolve
  // it lazily: a computer that never touches the network must boot (and keep
  // working) without the Host port, and the port handshake must not gate the
  // terminal.
  let truapiPromise: Promise<TrUApiClient> | null = null;
  const lazyTruapi = async (): Promise<TrUApiClient> =>
    createClient(
      createTransport(createMessagePortProvider(await waitForTruapiPort())),
    );
  const truapi = (): Promise<TrUApiClient> => (truapiPromise ??= lazyTruapi());
  validateComputerFiles(files, descriptor);

  const { screen, status } = createComputerShell();
  const geometry = terminalGeometry(screen);
  const terminal = new ComputerTerminal(geometry.columns, geometry.rows);

  const runtime = await fetch(`${PVM_RUNTIME_ROOT}/pvm-browser-runtime.wasm`, {
    cache: "force-cache",
  }).then((response) => {
    if (!response.ok) {
      throw new Error(
        `PolkaVM runtime fetch failed: HTTP ${String(response.status)}`,
      );
    }
    return response.arrayBuffer();
  });

  // Restore /home, then let archive seeds fill anything the user has not
  // touched. Seeds live under `home/` in the archive and mount at `/home/`.
  const saveKey = `${location.hostname}:computer:${cid}`;
  const restored = decodeFilesystem(
    (await loadSave(saveKey)) ?? new Uint8Array(),
  );
  let filesystemMetadata = restored.metadata;
  const mounts = new Map<string, Uint8Array>();
  for (const [path, bytes] of Object.entries(files)) {
    if (
      restored.metadata === null &&
      path.startsWith(HOME_PREFIX) &&
      path.length > HOME_PREFIX.length &&
      !path.endsWith("/")
    ) {
      mounts.set(`/${path}`, ownedBytes(bytes));
    }
  }
  for (const [path, bytes] of restored.files) {
    mounts.set(path, bytes);
  }
  const persisted = mounts;

  const workerFiles: WorkerFileEntry[] = [...mounts.entries()].map(
    ([path, bytes]) => ({ path, bytes: ownedBytes(bytes) }),
  );
  const packages = descriptor.packages.map((entry) => ({
    name: entry.name,
    bytes: ownedBytes(files[entry.path]),
  }));
  const program = ownedBytes(files[descriptor.programPath]);

  const worker = new Worker("/pvm-computer-worker.js");

  let renderQueued = false;
  const scheduleRender = (): void => {
    if (renderQueued) {
      return;
    }
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderSnapshot(screen, terminal.snapshot());
    });
  };

  // Open spawn: the guest may name any published app. The sandbox cannot
  // resolve DotNS itself, so it asks the host shell for the label's
  // executable record and contenthash, then fetches and verifies the
  // archive exactly like a top-level app before handing the program to
  // the worker. The host (not this code) owns any consent policy.
  let resolveNonce = 0;
  const resolveAppRecord = (
    label: string,
  ): Promise<{ cid: string; executableManifest: string }> => {
    const nonce = `computer-${String(resolveNonce++)}-${String(Date.now())}`;
    const { promise, resolve, reject } = Promise.withResolvers<{
      cid: string;
      executableManifest: string;
    }>();
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as {
        type?: string;
        nonce?: string;
        cid?: string;
        executableManifest?: string;
        message?: string;
      } | null;
      if (event.source !== window.parent || data?.nonce !== nonce) {
        return;
      }
      if (
        data.type === "dotli:computer-app" &&
        typeof data.cid === "string" &&
        typeof data.executableManifest === "string"
      ) {
        cleanup();
        resolve({ cid: data.cid, executableManifest: data.executableManifest });
      } else if (data.type === "dotli:computer-app-error") {
        cleanup();
        reject(new Error(data.message ?? `cannot resolve ${label}`));
      }
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`resolving ${label} timed out`));
    }, RESOLVE_TIMEOUT_MS);
    const cleanup = (): void => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage(
      { type: "dotli:computer-resolve-app", label, nonce },
      "*",
    );
    return promise;
  };

  const fetchPackage = async (
    label: string,
  ): Promise<{ bytes: Uint8Array; files: WorkerFileEntry[] }> => {
    const record = await resolveAppRecord(label);
    // Dynamic on purpose: the fetch chunk and the bitswap bridge are
    // code-split exactly as in main.ts, so computers that never spawn a
    // remote package never load them.
    const { fetchArchive } = await import("@dotli/content/fetch");
    const isGateway =
      new URLSearchParams(location.search).get("chainBackend") ===
      "rpc-gateway";
    const result = isGateway
      ? await fetchArchive(record.cid, () => undefined, { useGateway: true })
      : await fetchArchive(record.cid, () => undefined, {
          bitswapBlockSource: (await import("./bitswap-bridge"))
            .requestBitswapBlock,
        });
    if (result.type !== "archive") {
      throw new Error(`${label} did not resolve to an app archive`);
    }
    // The child is authorized by its own signed manifest: it must declare
    // the same host contract, and its grant clamps to this computer's.
    const childDescriptor = parseComputerManifest(
      result.files,
      record.executableManifest,
      true,
    );
    if (childDescriptor === null) {
      throw new Error(`${label} is not a polkadot-host computer app`);
    }
    validateComputerFiles(result.files, childDescriptor);
    if (childDescriptor.networkEnabled && !descriptor.networkEnabled) {
      throw new Error(`${label} cannot elevate the parent network capability`);
    }
    if (childDescriptor.workspaceEnabled && !descriptor.workspaceEnabled) {
      throw new Error(
        `${label} cannot elevate the parent workspace capability`,
      );
    }
    const childFiles: WorkerFileEntry[] = [];
    for (const [path, bytes] of Object.entries(result.files)) {
      if (
        path.startsWith(HOME_PREFIX) &&
        path.length > HOME_PREFIX.length &&
        !path.endsWith("/")
      ) {
        const mountedPath = `/${path}`;
        if (!mounts.has(mountedPath)) {
          childFiles.push({ path: mountedPath, bytes: ownedBytes(bytes) });
        }
      }
    }
    return {
      bytes: ownedBytes(result.files[childDescriptor.programPath]),
      files: childFiles,
    };
  };

  const resolvePackage = async (name: string): Promise<void> => {
    try {
      status.textContent = `Fetching ${name}…`;
      const child = await fetchPackage(name);
      status.textContent = "";
      worker.postMessage(
        { type: "package", name, bytes: child.bytes, files: child.files },
        [child.bytes.buffer, ...child.files.map((entry) => entry.bytes.buffer)],
      );
    } catch (error) {
      status.textContent = "";
      console.warn(`[pvm computer] resolving ${name} failed:`, error);
      worker.postMessage({ type: "package-error", name });
    }
  };

  let pendingSave = Promise.resolve();
  // Bytes and metadata from one worker checkpoint become one IDB record.
  // Serializing writes prevents an older asynchronous save replacing a newer one.
  const persistNow = (): void => {
    if (filesystemMetadata === null) {
      return;
    }
    const record = encodeFilesystem(persisted, filesystemMetadata);
    if (record === null) {
      status.textContent =
        "Filesystem exceeds the save budget — changes are not persisted.";
      return;
    }
    pendingSave = pendingSave
      .then(() => storeSave(saveKey, record))
      .catch((error: unknown) => {
        status.textContent = `Filesystem save failed: ${error instanceof Error ? error.message : String(error)}`;
      });
  };

  let running = false;
  worker.onmessage = (event: MessageEvent) => {
    const message = event.data as {
      type: string;
      bytes?: Uint8Array;
      entries?: WorkerFileEntry[];
      removed?: string[];
      metadata?: FilesystemMetadata | null;
      code?: number;
      message?: string;
      name?: string;
      domain?: string;
      nonce?: string;
      translationMs?: number;
    };
    switch (message.type) {
      case "network-permission":
        if (
          typeof message.domain === "string" &&
          typeof message.nonce === "string"
        ) {
          const { domain, nonce } = message;
          void truapi()
            .then((client) =>
              client.permissions.requestRemotePermission({
                permission: {
                  tag: "Remote",
                  value: { domains: [domain] },
                },
              }),
            )
            .then((result) => result.isOk() && result.value.granted)
            .catch(() => false)
            .then((granted) => {
              worker.postMessage({
                type: "network-permission-result",
                nonce,
                granted,
              });
            });
        }
        break;
      case "started":
        running = true;
        status.textContent = "";
        screen.dataset.computerReady = "true";
        if (typeof message.translationMs === "number") {
          screen.dataset.computerTranslationMs = String(
            Math.round(message.translationMs),
          );
        }
        screen.focus();
        break;
      case "output":
        if (message.bytes instanceof Uint8Array) {
          terminal.write(message.bytes);
          scheduleRender();
        }
        break;
      case "files":
        for (const entry of message.entries ?? []) {
          persisted.set(entry.path, entry.bytes);
        }
        for (const path of message.removed ?? []) {
          persisted.delete(path);
        }
        if (message.metadata !== undefined && message.metadata !== null) {
          filesystemMetadata = message.metadata;
        }
        persistNow();
        break;
      case "resolve-package":
        if (typeof message.name === "string") {
          void resolvePackage(message.name);
        }
        break;
      case "exit":
        running = false;
        screen.dataset.computerExit = String(message.code ?? 0);
        status.textContent = `Computer exited with status ${String(message.code ?? 0)} — reload to restart.`;
        break;
      case "log":
        console.warn(`[pvm computer] ${message.message ?? ""}`);
        break;
      case "error":
        running = false;
        screen.dataset.computerFault = message.message ?? "unknown";
        status.textContent = `Computer fault: ${message.message ?? "unknown"}`;
        break;
      default:
        break;
    }
  };
  worker.onerror = (event) => {
    running = false;
    status.textContent = `Computer worker error: ${event.message}`;
  };

  const sendInput = (bytes: Uint8Array): void => {
    if (!running) {
      return;
    }
    const owned = ownedBytes(bytes);
    worker.postMessage({ type: "input", bytes: owned }, [owned.buffer]);
  };

  screen.addEventListener("keydown", (event) => {
    const bytes = keyEventToBytes(event);
    if (bytes !== null) {
      event.preventDefault();
      sendInput(bytes);
    }
  });
  screen.addEventListener("paste", (event) => {
    event.preventDefault();
    const text = event.clipboardData?.getData("text");
    if (text !== undefined && text !== "" && running) {
      sendInput(
        encoder.encode(text.replaceAll("\r\n", "\r").replaceAll("\n", "\r")),
      );
    }
  });
  screen.addEventListener("mousedown", () => {
    screen.focus();
  });

  let resizeTimer: number | undefined;
  const observer = new ResizeObserver(() => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeTimer = undefined;
      const next = terminalGeometry(screen);
      const current = terminal.snapshot();
      if (next.columns === current.columns && next.rows === current.rows) {
        return;
      }
      terminal.resize(next.columns, next.rows);
      scheduleRender();
      if (running) {
        worker.postMessage({
          type: "resize",
          columns: next.columns,
          rows: next.rows,
        });
      }
    }, RESIZE_DEBOUNCE_MS);
  });
  observer.observe(screen);

  scheduleRender();
  // When the build has no TCP relay configured, boot the app but keep
  // networking disabled: the guest still works for shell, editing, etc.
  // and every TCP hostcall returns STATUS_DENIED.
  const networkEnabled = descriptor.networkEnabled && TCP_RELAY_URL !== "";
  worker.postMessage(
    {
      type: "start",
      runtime,
      program,
      packages,
      files: workerFiles,
      filesystemMetadata,
      argv: [
        descriptor.programPath
          .replace(/\.polkavm$/, "")
          .split("/")
          .pop() ?? descriptor.programPath,
      ],
      environment: [
        ["HOME", "/home"],
        ["TERM", "xterm"],
      ],
      columns: geometry.columns,
      rows: geometry.rows,
      networkEnabled,
      workspaceEnabled: descriptor.workspaceEnabled,
      relayUrl: TCP_RELAY_URL,
      maxGas: MAX_GAS,
    },
    [
      runtime,
      program.buffer,
      ...packages.map((entry) => entry.bytes.buffer),
      ...workerFiles.map((entry) => entry.bytes.buffer),
    ],
  );
}
