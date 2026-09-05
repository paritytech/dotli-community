/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Browser implementation of the experimental `polkadot-host-computer/0.1`
 * contract over translated PolkaVM guests.
 *
 * The native reference implementation lives in
 * rust/crates/pvm-runtime/src/computer.rs; this file mirrors its observable
 * semantics (status codes, limits, record encodings, supervisor state
 * machine) and is held to it by running the same conformance fixtures in
 * test/computer.test.mjs. Guests are not recompiled for the web: their
 * PolkaVM bytecode is translated to wasm by the staged translator in
 * pvm-browser-runtime.wasm, and every hostcall is handled here.
 *
 * Networking is denied unless the embedding Host injects a byte-stream provider.
 * Workspace management is denied unless the embedder grants host.workspace
 * to the root computer through setWorkspaceEnabled.
 */

"use strict";

(() => {
  const STATUS_FINISHED = -1;
  const STATUS_ECALL = -2;
  const STATUS_TRAP = -3;
  const STATUS_OUT_OF_GAS = -4;

  // Status codes and limits mirrored from computer.rs.
  const STATUS_WOULD_BLOCK = -1;
  const STATUS_BAD_HANDLE = -2;
  const STATUS_INVALID = -3;
  const STATUS_NOT_FOUND = -4;
  const STATUS_DENIED = -5;
  const STATUS_LIMIT = -6;
  const STATUS_EXISTS = -7;
  const STATUS_NOT_DIRECTORY = -8;
  const STATUS_IS_DIRECTORY = -9;
  const STATUS_NOT_EMPTY = -10;

  const COMPUTER_TTY_HANDLE = 1;
  const TTY_MODE_RAW = 1;
  const TTY_MODE_ECHO = 2;
  const MAX_TTY_INPUT_BYTES = 64 * 1024;
  const MAX_TTY_OUTPUT_BYTES = 1024 * 1024;
  const MAX_COMPUTER_FILES = 64;
  const MAX_COMPUTER_DIRECTORIES = 256;
  const MAX_COMPUTER_FILE_BYTES = 1024 * 1024;
  const MAX_OPEN_COMPUTER_FILES = 16;
  const MAX_COMPUTER_PATH_BYTES = 200;
  const MAX_COMPUTER_CONTEXT_BYTES = 64 * 1024;
  const MAX_COMPUTER_CONTEXT_ENTRIES = 1024;
  const MAX_COMPUTER_PROCESSES = 4;
  const MAX_BACKGROUND_PROCESSES = 4;
  const MAX_WORKSPACE_CHILDREN = 9;
  const FIRST_FILE_HANDLE = 16;
  const MAX_TTY_TRANSFER = 64 * 1024;
  const MAX_RANDOM_BYTES = 4 * 1024;
  const MAX_OPEN_SOCKETS = 4;
  const FIRST_SOCKET_HANDLE = 0x1000;
  const MAX_NET_ADDRESS_BYTES = 256;
  const MAX_NET_BUFFER_BYTES = 1024 * 1024;
  const MAX_NET_BUFFER_CHUNKS = 1024;
  const MAX_FS_TRANSFER = 1024 * 1024;
  const FS_OPEN_READ = 1;
  const FS_OPEN_WRITE = 2;
  const FS_OPEN_CREATE = 4;
  const FS_OPEN_TRUNCATE = 8;
  const FS_OPEN_EXCLUSIVE = 16;
  const FS_OPEN_APPEND = 32;
  const FAULTED_CHILD_STATUS = 139;
  const MAX_FAULT_POPS_PER_RUN = 32;
  const MAX_DRIVE_STEPS = 1024;
  const MAX_WORKSPACE_DRIVE_STEPS = 64;
  const AT_PAGESZ = 6n;

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();

  function readMetadata(module) {
    const sections = WebAssembly.Module.customSections(
      module,
      "epoca.pvm.meta",
    );
    if (sections.length !== 1) {
      throw new Error("translated PolkaVM module has invalid metadata");
    }
    const bytes = new Uint8Array(sections[0]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const requireBytes = (length) => {
      if (offset + length > bytes.byteLength) {
        throw new Error("translated PolkaVM metadata is truncated");
      }
    };
    const readU16 = () => {
      requireBytes(2);
      const value = view.getUint16(offset, true);
      offset += 2;
      return value;
    };
    const readU32 = () => {
      requireBytes(4);
      const value = view.getUint32(offset, true);
      offset += 4;
      return value;
    };
    const readString = (length) => {
      requireBytes(length);
      const value = new TextDecoder().decode(
        bytes.subarray(offset, offset + length),
      );
      offset += length;
      return value;
    };
    requireBytes(4);
    if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "EPM2") {
      throw new Error("translated PolkaVM metadata has an incompatible ABI");
    }
    offset = 4;
    const is64Bit = readU32() !== 0;
    const names = [
      "roAddress",
      "roSize",
      "roPhysical",
      "rwAddress",
      "rwSize",
      "rwPhysical",
      "heapBase",
      "heapLimit",
      "stackLow",
      "stackHigh",
      "stackPhysical",
    ];
    const layout = {};
    for (const name of names) {
      layout[name] = readU32();
    }
    const imports = [];
    const importCount = readU32();
    for (let index = 0; index < importCount; index++) {
      const length = readU16();
      imports.push(length ? readString(length) : null);
    }
    const exports = new Map();
    const exportCount = readU32();
    for (let index = 0; index < exportCount; index++) {
      const name = readString(readU16());
      const block = readU32();
      exports.set(name, block);
    }
    return { is64Bit, layout, imports, exports };
  }

  function validPath(path) {
    if (
      typeof path !== "string" ||
      encoder.encode(path).byteLength > MAX_COMPUTER_PATH_BYTES ||
      decoder.decode(encoder.encode(path)) !== path ||
      (path !== "/home" && !path.startsWith("/home/")) ||
      path.endsWith("/") ||
      path.includes("//") ||
      path.includes("\0") ||
      path.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      return null;
    }
    return path;
  }

  function parentPath(path) {
    return path.slice(0, path.lastIndexOf("/"));
  }

  function comparePaths(left, right) {
    const a = encoder.encode(left);
    const b = encoder.encode(right);
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
  }

  /** One in-memory namespace shared by every process in a supervisor tree.
   * fs_sync promises visibility only, not durable persistence. */
  class ComputerFilesystem {
    constructor() {
      this.files = new Map();
      this.entries = new Map([["/home", { kind: 2, mtimeNs: 0n, inode: 1n }]]);
      this.nextInode = 2n;
      this.clockNs = 0n;
      this.modified = new Set();
      this.removed = new Set();
      this.metadataDirty = false;
      this.openPaths = new Map();
      this.clients = new Set();
    }

    canMutate(inodes = 0) {
      return (
        this.clockNs < 0xffffffffffffffffn &&
        this.nextInode + BigInt(inodes) <= 0xffffffffffffffffn
      );
    }

    tick() {
      const now = BigInt(Date.now()) * 1000000n;
      this.clockNs = now > this.clockNs ? now : this.clockNs + 1n;
      return this.clockNs;
    }

    touch(path, timestamp = this.tick()) {
      this.entries.get(path).mtimeNs = timestamp;
      this.metadataDirty = true;
    }

    create(path, kind, dirty = true, timestamp = this.tick()) {
      this.entries.set(path, {
        kind,
        mtimeNs: timestamp,
        inode: this.nextInode++,
      });
      if (dirty) {
        this.touch(parentPath(path), timestamp);
        this.metadataDirty = true;
      }
    }

    missingStatus(path) {
      for (
        let ancestor = parentPath(path);
        ancestor.startsWith("/home");
        ancestor = parentPath(ancestor)
      ) {
        if (this.entries.get(ancestor)?.kind === 1) return STATUS_NOT_DIRECTORY;
      }
      return STATUS_NOT_FOUND;
    }

    parentStatus(path) {
      const parent = this.entries.get(parentPath(path));
      return parent === undefined
        ? this.missingStatus(parentPath(path))
        : parent.kind !== 2
          ? STATUS_NOT_DIRECTORY
          : 0;
    }

    directoryCount() {
      return this.entries.size - this.files.size - 1;
    }

    isOpen(path, subtree = false) {
      for (const open of this.openPaths.keys()) {
        if (open === path || (subtree && open.startsWith(`${path}/`)))
          return true;
      }
      return false;
    }

    mountFile(path, bytes) {
      if (validPath(path) === null)
        throw new Error(`invalid computer file path ${path}`);
      if (bytes.byteLength > MAX_COMPUTER_FILE_BYTES)
        throw new Error("mounted file exceeds the size limit");
      if (this.entries.get(path)?.kind === 2 || this.isOpen(path))
        throw new Error("mounted path is a directory or open");
      if (!this.files.has(path) && this.files.size >= MAX_COMPUTER_FILES)
        throw new Error("computer filesystem file limit exceeded");
      const parents = [];
      for (
        let parent = parentPath(path);
        parent !== "/home";
        parent = parentPath(parent)
      ) {
        const entry = this.entries.get(parent);
        if (entry?.kind === 1)
          throw new Error("mounted file parent is not a directory");
        if (entry === undefined) parents.push(parent);
      }
      if (this.directoryCount() + parents.length > MAX_COMPUTER_DIRECTORIES)
        throw new Error("computer filesystem directory limit exceeded");
      const creations = parents.length + (this.entries.has(path) ? 0 : 1);
      if (creations > 0 && !this.canMutate(creations))
        throw new Error("computer filesystem metadata limit exceeded");
      const copy = Uint8Array.from(bytes);
      const timestamp = creations > 0 ? this.tick() : this.clockNs;
      for (const parent of parents.reverse())
        this.create(parent, 2, false, timestamp);
      if (!this.entries.has(path)) this.create(path, 1, false, timestamp);
      this.files.set(path, copy);
      this.removed.delete(path);
    }

    takeModifiedFiles() {
      const changed = [];
      for (const path of this.modified) {
        const bytes = this.files.get(path);
        if (bytes !== undefined) changed.push([path, bytes.slice()]);
      }
      this.modified.clear();
      return changed;
    }

    takeRemovedFiles() {
      const removed = [...this.removed];
      this.removed.clear();
      return removed;
    }

    exportFilesystemMetadata() {
      return {
        version: 1,
        nextInode: this.nextInode.toString(),
        clockNs: this.clockNs.toString(),
        entries: [...this.entries]
          .sort(([a], [b]) => comparePaths(a, b))
          .map(([path, entry]) => ({
            path,
            kind: entry.kind,
            mtimeNs: entry.mtimeNs.toString(),
            inode: entry.inode.toString(),
          })),
      };
    }

    takeFilesystemMetadata() {
      if (!this.metadataDirty) return null;
      const metadata = this.exportFilesystemMetadata();
      this.metadataDirty = false;
      return metadata;
    }

    importFilesystemMetadata(metadata) {
      const invalid = () => {
        throw new Error("invalid computer filesystem metadata");
      };
      const u64 = (value) => {
        if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
          return invalid();
        const number = BigInt(value);
        if (number > 0xffffffffffffffffn) return invalid();
        return number;
      };
      if (this.clients.size > 1 || this.openPaths.size !== 0)
        throw new Error(
          "filesystem metadata restore requires no live children or open files",
        );
      if (
        metadata?.version !== 1 ||
        !Array.isArray(metadata.entries) ||
        metadata.entries.length >
          MAX_COMPUTER_FILES + MAX_COMPUTER_DIRECTORIES + 1
      )
        invalid();
      if (
        Object.keys(metadata).some(
          (key) =>
            !["version", "nextInode", "clockNs", "entries"].includes(key),
        )
      )
        invalid();
      const nextInode = u64(metadata.nextInode);
      const clockNs = u64(metadata.clockNs);
      const entries = new Map();
      const inodes = new Set();
      let fileCount = 0;
      let directoryCount = 0;
      for (const entry of metadata.entries) {
        if (
          entry === null ||
          validPath(entry.path) === null ||
          entries.has(entry.path) ||
          (entry.kind !== 1 && entry.kind !== 2)
        )
          invalid();
        if (
          Object.keys(entry).some(
            (key) => !["path", "kind", "mtimeNs", "inode"].includes(key),
          )
        )
          invalid();
        const inode = u64(entry.inode);
        const mtimeNs = u64(entry.mtimeNs);
        if (
          inode === 0n ||
          inode >= nextInode ||
          inodes.has(inode) ||
          mtimeNs > clockNs
        )
          invalid();
        inodes.add(inode);
        entries.set(entry.path, { kind: entry.kind, inode, mtimeNs });
        if (entry.kind === 1) {
          if (!this.files.has(entry.path)) invalid();
          fileCount++;
        } else directoryCount++;
      }
      if (
        entries.get("/home")?.kind !== 2 ||
        fileCount !== this.files.size ||
        directoryCount > MAX_COMPUTER_DIRECTORIES + 1
      )
        invalid();
      for (const path of entries.keys()) {
        if (path !== "/home" && entries.get(parentPath(path))?.kind !== 2)
          invalid();
      }
      this.entries = entries;
      this.nextInode = nextInode;
      this.clockNs = clockNs;
      this.metadataDirty = false;
    }
  }

  function encodeStringRecord(strings, count = strings.length) {
    const parts = [];
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, count, true);
    parts.push(header);
    for (const value of strings) {
      const bytes = encoder.encode(value);
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, bytes.byteLength, true);
      parts.push(length, bytes);
    }
    let total = 0;
    for (const part of parts) {
      total += part.byteLength;
    }
    if (total > MAX_COMPUTER_CONTEXT_BYTES) {
      throw new Error("computer context record exceeds the host limit");
    }
    const record = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      record.set(part, offset);
      offset += part.byteLength;
    }
    return record;
  }

  /** Validates and encodes a computer launch context (mirror of
   * ComputerContext::new). */
  function computerContext(argumentsList, environmentPairs) {
    if (
      argumentsList.length > MAX_COMPUTER_CONTEXT_ENTRIES ||
      environmentPairs.length > MAX_COMPUTER_CONTEXT_ENTRIES
    ) {
      throw new Error("computer context entry count exceeds the host limit");
    }
    for (const argument of argumentsList) {
      if (argument.includes("\0")) {
        throw new Error("computer arguments must not contain NUL bytes");
      }
    }
    const seen = new Set();
    for (const [key, value] of environmentPairs) {
      if (!key || key.includes("=") || key.includes("\0") || seen.has(key)) {
        throw new Error(`invalid computer environment key ${key}`);
      }
      if (value.includes("\0")) {
        throw new Error("computer environment values must not contain NUL");
      }
      seen.add(key);
    }
    const flattened = [];
    for (const [key, value] of environmentPairs) {
      flattened.push(key, value);
    }
    return {
      arguments: argumentsList.slice(),
      environment: environmentPairs.map((pair) => pair.slice()),
      encodedArguments: encodeStringRecord(argumentsList),
      // The environment record counts key/value ENTRIES while flattening
      // both strings, mirroring ComputerContext's encoder.
      encodedEnvironment: encodeStringRecord(
        flattened,
        environmentPairs.length,
      ),
    };
  }

  /**
   * Generic WebSocket-to-TCP relay provider for browser Hosts.
   *
   * Protocol: the client opens `relayUrl`, sends one JSON text frame
   * `{ \"version\": 1, \"address\": \"host:port\" }`, waits for
   * `{ \"type\": \"connected\" }`, then exchanges raw TCP bytes as binary
   * frames. `{ \"type\": \"error\" }` or WebSocket closure terminates the
   * stream. TLS/HTTP/SSH remain entirely inside the guest.
   */
  class WebSocketTcpProvider {
    constructor(
      relayUrl,
      onActivity = null,
      WebSocketClass = globalThis.WebSocket,
    ) {
      if (typeof relayUrl !== "string" || relayUrl.length === 0) {
        throw new Error("TCP relay URL must be non-empty");
      }
      if (typeof WebSocketClass !== "function") {
        throw new Error("WebSocket is unavailable in this Host");
      }
      this.relayUrl = relayUrl;
      this.onActivity = onActivity;
      this.WebSocketClass = WebSocketClass;
    }

    connect(address) {
      return new WebSocketTcpSocket(
        this.relayUrl,
        address,
        this.onActivity,
        this.WebSocketClass,
      );
    }
  }

  class WebSocketTcpSocket {
    constructor(relayUrl, address, onActivity, WebSocketClass) {
      this.incoming = [];
      this.incomingOffset = 0;
      this.incomingBytes = 0;
      this.receiveFailed = false;
      this.connected = false;
      this.closed = false;
      this.onActivity = onActivity;
      this.socket = new WebSocketClass(relayUrl);
      this.socket.binaryType = "arraybuffer";
      this.socket.onopen = () => {
        if (this.closed) return;
        this.socket.send(JSON.stringify({ version: 1, address }));
      };
      this.socket.onmessage = (event) => {
        if (this.closed) return;
        if (typeof event.data === "string") {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch {
            this.#terminate();
            return;
          }
          if (message?.type === "connected") {
            this.connected = true;
            this.#activity();
          } else if (message?.type === "error") {
            this.#terminate();
          }
          return;
        }
        const bytes =
          event.data instanceof ArrayBuffer
            ? new Uint8Array(event.data)
            : ArrayBuffer.isView(event.data)
              ? new Uint8Array(
                  event.data.buffer,
                  event.data.byteOffset,
                  event.data.byteLength,
                )
              : null;
        if (bytes === null) {
          this.#terminate();
          return;
        }
        if (
          !this.connected ||
          this.incomingBytes + bytes.byteLength > MAX_NET_BUFFER_BYTES ||
          (bytes.byteLength > 0 &&
            this.incoming.length >= MAX_NET_BUFFER_CHUNKS)
        ) {
          this.receiveFailed = true;
          this.incoming.length = 0;
          this.incomingOffset = 0;
          this.incomingBytes = 0;
          this.#terminate();
          return;
        }
        if (bytes.byteLength > 0) {
          this.incoming.push(bytes.slice());
          this.incomingBytes += bytes.byteLength;
        }
        this.#activity();
      };
      this.socket.onclose = () => this.#terminate();
      this.socket.onerror = () => this.#terminate();
    }

    read(capacity) {
      if (this.receiveFailed) {
        throw new Error("TCP relay receive limit or protocol violation");
      }
      if (this.incoming.length === 0) {
        return this.closed ? new Uint8Array() : null;
      }
      const output = new Uint8Array(capacity);
      let written = 0;
      while (written < capacity && this.incoming.length > 0) {
        const chunk = this.incoming[0];
        const available = chunk.byteLength - this.incomingOffset;
        const count = Math.min(available, capacity - written);
        output.set(
          chunk.subarray(this.incomingOffset, this.incomingOffset + count),
          written,
        );
        written += count;
        this.incomingBytes -= count;
        this.incomingOffset += count;
        if (this.incomingOffset === chunk.byteLength) {
          this.incoming.shift();
          this.incomingOffset = 0;
        }
      }
      return output.subarray(0, written);
    }

    write(bytes) {
      if (!this.connected) {
        if (this.closed) {
          throw new Error("TCP relay stream is closed");
        }
        return null;
      }
      // Bound browser buffering; the guest yields and retries after activity.
      if (this.socket.bufferedAmount + bytes.byteLength > MAX_NET_BUFFER_BYTES) {
        return null;
      }
      const owned = bytes.slice();
      this.socket.send(owned.buffer);
      return owned.byteLength;
    }

    close() {
      this.#terminate();
    }

    #activity() {
      this.onActivity?.();
    }

    #terminate() {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.connected = false;
      this.socket.close();
      this.#activity();
    }
  }

  /** Terminal and filesystem devices granted to one computer guest
   * (mirror of ComputerDevices). */
  class ComputerDevices {
    constructor(networkProvider = null, filesystem = new ComputerFilesystem()) {
      this.ttyInput = [];
      this.ttyInputClosed = false;
      this.ttyOutput = [];
      this.ttyColumns = 80;
      this.ttyRows = 24;
      this.ttyMode = TTY_MODE_ECHO;
      this.filesystem = filesystem;
      filesystem.clients.add(this);
      this.files = filesystem.files;
      this.modified = filesystem.modified;
      this.removed = filesystem.removed;
      this.openFiles = new Map();
      this.networkProvider = networkProvider;
      this.networkEnabled = false;
      this.sockets = new Map();
      this.nextSocket = FIRST_SOCKET_HANDLE;
    }

    setNetworkEnabled(enabled) {
      this.networkEnabled = enabled;
      if (!enabled) {
        for (const handle of this.sockets.keys()) this.netClose(handle);
      }
    }

    netTcpConnect(address) {
      if (!this.networkEnabled || this.networkProvider === null) {
        return STATUS_DENIED;
      }
      if (this.sockets.size >= MAX_OPEN_SOCKETS) {
        return STATUS_LIMIT;
      }
      let socket;
      try {
        socket = this.networkProvider.connect(address);
      } catch {
        return STATUS_INVALID;
      }
      if (
        socket === null ||
        typeof socket.read !== "function" ||
        typeof socket.write !== "function" ||
        typeof socket.close !== "function"
      ) {
        return STATUS_INVALID;
      }
      if (this.nextSocket > 0xffffffff) {
        socket.close();
        return STATUS_LIMIT;
      }
      const handle = this.nextSocket++;
      this.sockets.set(handle, socket);
      return handle;
    }

    netRead(handle, capacity) {
      const socket = this.sockets.get(handle);
      if (socket === undefined) {
        return { status: STATUS_BAD_HANDLE, bytes: new Uint8Array() };
      }
      // The embedder's socket provider sets `denied = true` on a
      // permission-gated socket whose connect request was refused.
      if (socket.denied === true) {
        return { status: STATUS_DENIED, bytes: new Uint8Array() };
      }
      try {
        const bytes = socket.read(capacity);
        if (bytes === null) {
          return { status: STATUS_WOULD_BLOCK, bytes: new Uint8Array() };
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > capacity) {
          return { status: STATUS_INVALID, bytes: new Uint8Array() };
        }
        return { status: bytes.byteLength, bytes };
      } catch {
        return { status: STATUS_INVALID, bytes: new Uint8Array() };
      }
    }

    netWrite(handle, bytes) {
      const socket = this.sockets.get(handle);
      if (socket === undefined) {
        return STATUS_BAD_HANDLE;
      }
      if (socket.denied === true) {
        return STATUS_DENIED;
      }
      try {
        const written = socket.write(bytes);
        if (written === null) {
          return STATUS_WOULD_BLOCK;
        }
        return Number.isInteger(written) &&
          written >= 0 &&
          written <= bytes.byteLength
          ? written
          : STATUS_INVALID;
      } catch {
        return STATUS_INVALID;
      }
    }

    netClose(handle) {
      const socket = this.sockets.get(handle);
      if (socket === undefined) {
        return STATUS_BAD_HANDLE;
      }
      this.sockets.delete(handle);
      try {
        socket.close();
        return 0;
      } catch {
        return STATUS_INVALID;
      }
    }

    pushTerminalInput(bytes) {
      if (this.ttyInputClosed) {
        throw new Error("terminal input is closed");
      }
      if (this.ttyInput.length + bytes.length > MAX_TTY_INPUT_BYTES) {
        throw new Error("terminal input queue limit exceeded");
      }
      for (const byte of bytes) {
        this.ttyInput.push(byte);
      }
    }

    closeInput() {
      this.ttyInputClosed = true;
    }

    inputSpace() {
      if (this.ttyInputClosed) {
        return 0;
      }
      return Math.max(0, MAX_TTY_INPUT_BYTES - this.ttyInput.length);
    }

    takeTerminalOutput() {
      if (this.ttyOutput.length === 0) {
        return null;
      }
      const output = Uint8Array.from(this.ttyOutput);
      this.ttyOutput.length = 0;
      return output;
    }

    mountFile(path, bytes) {
      this.filesystem.mountFile(path, bytes);
    }

    takeModifiedFiles() {
      return this.filesystem.takeModifiedFiles();
    }

    takeRemovedFiles() {
      return this.filesystem.takeRemovedFiles();
    }

    exportFilesystemMetadata() {
      return this.filesystem.exportFilesystemMetadata();
    }

    importFilesystemMetadata(metadata) {
      this.filesystem.importFilesystemMetadata(metadata);
    }

    takeFilesystemMetadata() {
      return this.filesystem.takeFilesystemMetadata();
    }

    dispose() {
      for (const handle of this.openFiles.keys()) this.fsClose(handle);
      this.filesystem.clients.delete(this);
      this.networkEnabled = false;
      for (const socket of this.sockets.values()) {
        try {
          socket.close();
        } catch {
          // Provider teardown failures must not prevent other process cleanup.
        }
      }
      this.sockets.clear();
    }

    hasTerminalInput() {
      return this.ttyInput.length > 0;
    }

    terminalMode() {
      return this.ttyMode;
    }

    ttyReadInto(handle, capacity) {
      if (handle !== COMPUTER_TTY_HANDLE) {
        return { status: STATUS_BAD_HANDLE };
      }
      if (capacity === 0) {
        return { status: STATUS_INVALID };
      }
      if (this.ttyInput.length === 0) {
        return { status: this.ttyInputClosed ? 0 : STATUS_WOULD_BLOCK };
      }
      const count = Math.min(capacity, this.ttyInput.length);
      const bytes = Uint8Array.from(this.ttyInput.slice(0, count));
      this.ttyInput.splice(0, count);
      return { status: count, bytes };
    }

    ttyWrite(handle, bytes) {
      if (handle !== COMPUTER_TTY_HANDLE) {
        return STATUS_BAD_HANDLE;
      }
      const available = Math.max(
        0,
        MAX_TTY_OUTPUT_BYTES - this.ttyOutput.length,
      );
      const written = Math.min(bytes.length, available);
      for (let index = 0; index < written; index++) {
        this.ttyOutput.push(bytes[index]);
      }
      return written;
    }

    ttySetMode(handle, flags) {
      if (handle !== COMPUTER_TTY_HANDLE) {
        return STATUS_BAD_HANDLE;
      }
      if ((flags & ~(TTY_MODE_RAW | TTY_MODE_ECHO)) !== 0) {
        return STATUS_INVALID;
      }
      this.ttyMode = flags;
      return 0;
    }

    fsOpen(path, flags) {
      if (
        validPath(path) === null ||
        !Number.isInteger(flags) ||
        flags < 0 ||
        flags > 63
      )
        return STATUS_INVALID;
      const readable = (flags & FS_OPEN_READ) !== 0;
      const writable = (flags & FS_OPEN_WRITE) !== 0;
      const create = (flags & FS_OPEN_CREATE) !== 0;
      const truncate = (flags & FS_OPEN_TRUNCATE) !== 0;
      const exclusive = (flags & FS_OPEN_EXCLUSIVE) !== 0;
      const append = (flags & FS_OPEN_APPEND) !== 0;
      if (
        (!readable && !writable) ||
        ((create || truncate || exclusive || append) && !writable) ||
        (exclusive && !create)
      )
        return STATUS_INVALID;
      const fs = this.filesystem;
      const entry = fs.entries.get(path);
      if (entry !== undefined && exclusive) return STATUS_EXISTS;
      if (entry?.kind === 2) return STATUS_IS_DIRECTORY;
      if (entry === undefined && fs.missingStatus(path) === STATUS_NOT_DIRECTORY)
        return STATUS_NOT_DIRECTORY;
      if (this.openFiles.size >= MAX_OPEN_COMPUTER_FILES) return STATUS_LIMIT;
      if (entry === undefined) {
        if (!create) return STATUS_NOT_FOUND;
        const parentStatus = fs.parentStatus(path);
        if (parentStatus !== 0) return parentStatus;
        if (this.files.size >= MAX_COMPUTER_FILES) return STATUS_LIMIT;
      }
      if (
        (entry === undefined || truncate) &&
        !fs.canMutate(entry === undefined ? 1 : 0)
      )
        return STATUS_LIMIT;
      let handle = FIRST_FILE_HANDLE;
      while (this.openFiles.has(handle)) handle++;
      if (entry === undefined || truncate) {
        this.files.set(path, new Uint8Array(0));
        if (entry === undefined) fs.create(path, 1);
        else fs.touch(path);
        this.modified.add(path);
        this.removed.delete(path);
      }
      this.openFiles.set(handle, {
        path,
        position: 0,
        readable,
        writable,
        append,
      });
      fs.openPaths.set(path, (fs.openPaths.get(path) ?? 0) + 1);
      return handle;
    }

    fsRead(handle, capacity) {
      const open = this.openFiles.get(handle);
      if (open === undefined) {
        return { status: STATUS_BAD_HANDLE };
      }
      if (!open.readable) {
        return { status: STATUS_DENIED };
      }
      const file = this.files.get(open.path);
      if (file === undefined) {
        return { status: STATUS_NOT_FOUND };
      }
      const start = Math.min(open.position, file.byteLength);
      const length = Math.min(capacity, file.byteLength - start);
      const bytes = file.slice(start, start + length);
      open.position = start + length;
      return { status: length, bytes };
    }

    fsWrite(handle, bytes) {
      const open = this.openFiles.get(handle);
      if (open === undefined) {
        return STATUS_BAD_HANDLE;
      }
      if (!open.writable) {
        return STATUS_DENIED;
      }
      const file = this.files.get(open.path);
      if (file === undefined) {
        return STATUS_NOT_FOUND;
      }
      if (bytes.byteLength === 0) return 0;
      const position = open.append ? file.byteLength : open.position;
      const end = position + bytes.byteLength;
      if (end > MAX_COMPUTER_FILE_BYTES) {
        return STATUS_LIMIT;
      }
      if (!this.filesystem.canMutate()) return STATUS_LIMIT;
      let next = file;
      if (file.byteLength < end) {
        next = new Uint8Array(end);
        next.set(file);
        this.files.set(open.path, next);
      }
      next.set(bytes, position);
      open.position = end;
      this.modified.add(open.path);
      this.filesystem.touch(open.path);
      return bytes.byteLength;
    }

    fsSeek(handle, offset, whence) {
      const open = this.openFiles.get(handle);
      if (open === undefined) {
        return STATUS_BAD_HANDLE;
      }
      const file = this.files.get(open.path);
      if (file === undefined) {
        return STATUS_NOT_FOUND;
      }
      let base;
      if (whence === 0) {
        base = 0;
      } else if (whence === 1) {
        base = open.position;
      } else if (whence === 2) {
        base = file.byteLength;
      } else {
        return STATUS_INVALID;
      }
      const position = base + offset;
      if (position < 0 || position > MAX_COMPUTER_FILE_BYTES) {
        return STATUS_INVALID;
      }
      open.position = position;
      return position;
    }

    fsTruncate(handle, length) {
      if (length > MAX_COMPUTER_FILE_BYTES) {
        return STATUS_LIMIT;
      }
      const open = this.openFiles.get(handle);
      if (open === undefined) {
        return STATUS_BAD_HANDLE;
      }
      if (!open.writable) {
        return STATUS_DENIED;
      }
      const file = this.files.get(open.path);
      if (file === undefined) {
        return STATUS_NOT_FOUND;
      }
      if (!this.filesystem.canMutate()) return STATUS_LIMIT;
      const next = new Uint8Array(length);
      next.set(file.subarray(0, Math.min(length, file.byteLength)));
      this.files.set(open.path, next);
      this.modified.add(open.path);
      this.filesystem.touch(open.path);
      return 0;
    }

    fsStat(path) {
      if (validPath(path) === null) {
        return null;
      }
      const file = this.files.get(path);
      return file === undefined ? null : file.byteLength;
    }

    fsSync(handle) {
      return this.openFiles.has(handle) ? 0 : STATUS_BAD_HANDLE;
    }

    fsClose(handle) {
      const open = this.openFiles.get(handle);
      if (open === undefined) return STATUS_BAD_HANDLE;
      this.openFiles.delete(handle);
      const count = this.filesystem.openPaths.get(open.path);
      if (count === 1) this.filesystem.openPaths.delete(open.path);
      else this.filesystem.openPaths.set(open.path, count - 1);
      return 0;
    }

    fsRemove(path) {
      if (validPath(path) === null) return STATUS_INVALID;
      const fs = this.filesystem;
      const entry = fs.entries.get(path);
      if (entry === undefined) return fs.missingStatus(path);
      if (entry.kind === 2) return STATUS_IS_DIRECTORY;
      if (fs.isOpen(path)) return STATUS_DENIED;
      if (!fs.canMutate()) return STATUS_LIMIT;
      this.files.delete(path);
      fs.entries.delete(path);
      this.modified.delete(path);
      this.removed.add(path);
      fs.touch(parentPath(path));
      return 0;
    }

    fsMkdir(path) {
      if (validPath(path) === null) return STATUS_INVALID;
      const fs = this.filesystem;
      if (fs.entries.has(path)) return STATUS_EXISTS;
      const status = fs.parentStatus(path);
      if (status !== 0) return status;
      if (fs.directoryCount() >= MAX_COMPUTER_DIRECTORIES) return STATUS_LIMIT;
      if (!fs.canMutate(1)) return STATUS_LIMIT;
      fs.create(path, 2);
      return 0;
    }

    fsRmdir(path) {
      if (validPath(path) === null) return STATUS_INVALID;
      const fs = this.filesystem;
      const entry = fs.entries.get(path);
      if (entry === undefined) return fs.missingStatus(path);
      if (entry.kind !== 2) return STATUS_NOT_DIRECTORY;
      if (path === "/home") return STATUS_DENIED;
      if (fs.isOpen(path, true)) return STATUS_DENIED;
      for (const child of fs.entries.keys()) {
        if (child.startsWith(`${path}/`)) return STATUS_NOT_EMPTY;
      }
      if (!fs.canMutate()) return STATUS_LIMIT;
      fs.entries.delete(path);
      fs.touch(parentPath(path));
      return 0;
    }

    fsRename(oldPath, newPath) {
      if (validPath(oldPath) === null || validPath(newPath) === null)
        return STATUS_INVALID;
      const fs = this.filesystem;
      const source = fs.entries.get(oldPath);
      if (source === undefined) return fs.missingStatus(oldPath);
      if (oldPath === newPath) return 0;
      if (oldPath === "/home" || newPath === "/home") return STATUS_DENIED;
      if (source.kind === 2 && newPath.startsWith(`${oldPath}/`))
        return STATUS_INVALID;
      const status = fs.parentStatus(newPath);
      if (status !== 0) return status;
      const destination = fs.entries.get(newPath);
      if (destination !== undefined && source.kind !== destination.kind) {
        return source.kind === 1 ? STATUS_IS_DIRECTORY : STATUS_NOT_DIRECTORY;
      }
      if (fs.isOpen(oldPath, true) || fs.isOpen(newPath, true))
        return STATUS_DENIED;
      if (destination?.kind === 2) {
        for (const path of fs.entries.keys()) {
          if (path.startsWith(`${newPath}/`)) return STATUS_NOT_EMPTY;
        }
      }
      const moves = [];
      for (const [path, entry] of fs.entries) {
        if (path === oldPath || path.startsWith(`${oldPath}/`)) {
          const target = newPath + path.slice(oldPath.length);
          if (validPath(target) === null) return STATUS_INVALID;
          moves.push([path, target, entry, this.files.get(path)]);
        }
      }
      if (!fs.canMutate()) return STATUS_LIMIT;
      fs.entries.delete(newPath);
      for (const [path, , , bytes] of moves) {
        fs.entries.delete(path);
        if (bytes !== undefined) {
          this.files.delete(path);
          this.modified.delete(path);
          this.removed.add(path);
        }
      }
      for (const [, target, entry, bytes] of moves) {
        fs.entries.set(target, entry);
        if (bytes !== undefined) {
          this.files.set(target, bytes);
          this.modified.add(target);
          this.removed.delete(target);
        }
      }
      const timestamp = fs.tick();
      fs.touch(parentPath(oldPath), timestamp);
      if (parentPath(oldPath) !== parentPath(newPath))
        fs.touch(parentPath(newPath), timestamp);
      return 0;
    }

    fsMetadata(path) {
      if (validPath(path) === null) return { status: STATUS_INVALID };
      const entry = this.filesystem.entries.get(path);
      if (entry === undefined) return { status: this.filesystem.missingStatus(path) };
      const record = new Uint8Array(24);
      const view = new DataView(record.buffer);
      view.setUint32(0, entry.kind, true);
      view.setUint32(4, this.files.get(path)?.byteLength ?? 0, true);
      view.setBigUint64(8, entry.mtimeNs, true);
      view.setBigUint64(16, entry.inode, true);
      return { status: 0, record };
    }

    fsFstat(handle) {
      const open = this.openFiles.get(handle);
      return open === undefined
        ? { status: STATUS_BAD_HANDLE }
        : this.fsMetadata(open.path);
    }

    fsListDirectory(path) {
      if (validPath(path) === null) return { status: STATUS_INVALID };
      const fs = this.filesystem;
      const entry = fs.entries.get(path);
      if (entry === undefined) return { status: fs.missingStatus(path) };
      if (entry.kind !== 2) return { status: STATUS_NOT_DIRECTORY };
      const children = [...fs.entries]
        .filter(([child]) => child !== "/home" && parentPath(child) === path)
        .sort(([a], [b]) => comparePaths(a, b))
        .map(([child, metadata]) => [
          encoder.encode(child.slice(path.length + 1)),
          metadata.kind,
        ]);
      const record = new Uint8Array(
        4 + children.reduce((size, [name]) => size + 8 + name.length, 0),
      );
      const view = new DataView(record.buffer);
      view.setUint32(0, children.length, true);
      let offset = 4;
      for (const [name, kind] of children) {
        view.setUint32(offset, name.length, true);
        record.set(name, offset + 4);
        view.setUint32(offset + 4 + name.length, kind, true);
        offset += 8 + name.length;
      }
      return { status: record.byteLength, record };
    }

    fsListRecord() {
      return encodeStringRecord([...this.files.keys()].sort(comparePaths));
    }
  }

  /** One translated computer guest process (mirror of ComputerRuntime). */
  class ComputerProcess {
    constructor(
      module,
      context,
      maxGas,
      emitLog = null,
      networkProvider = null,
      filesystem = new ComputerFilesystem(),
    ) {
      this.metadata = readMetadata(module);
      this.instance = new WebAssembly.Instance(module, {});
      this.pvm = this.instance.exports;
      this.memory = this.pvm.memory;
      this.maxGas = BigInt(maxGas);
      this.emitLog = emitLog;
      this.encodedArguments = context.encodedArguments;
      this.encodedEnvironment = context.encodedEnvironment;
      this.exitStatus = null;
      this.pendingSpawn = null;
      this.pendingChildRequest = null;
      this.resumePending = false;
      this.monotonicEpoch = performance.now();
      const start = this.metadata.exports.get("_pvm_start");
      if (start === undefined) {
        throw new Error("computer guests must export '_pvm_start'");
      }
      this.startBlock = start;
      this.#setup(context);
      this.devices = new ComputerDevices(networkProvider, filesystem);
    }

    /** Mirrors Vm::setup: argc/argv/envp/auxv stack for `_pvm_start`. */
    #setup(context) {
      const argc = BigInt(context.arguments.length);
      const envpLength = BigInt(context.environment.length);
      const auxv = [[AT_PAGESZ, 4096n]];
      let sp = BigInt(this.metadata.layout.stackHigh);
      sp -=
        (1n + argc + 1n + envpLength + 1n + BigInt(auxv.length + 1) * 2n) * 8n;
      const addressInit = sp;
      let pointer = sp;
      this.#writeU64(pointer, argc);
      pointer += 8n;
      for (const argument of context.arguments) {
        const bytes = encoder.encode(argument);
        sp -= BigInt(bytes.byteLength) + 1n;
        this.#write(Number(sp), bytes);
        this.#writeU64(pointer, sp);
        pointer += 8n;
      }
      pointer += 8n; // Null pointer.
      for (const [key, value] of context.environment) {
        const bytes = encoder.encode(`${key}=${value}`);
        sp -= BigInt(bytes.byteLength) + 1n;
        this.#write(Number(sp), bytes);
        this.#writeU64(pointer, sp);
        pointer += 8n;
      }
      pointer += 8n; // Null pointer.
      for (const [key, value] of auxv) {
        this.#writeU64(pointer, key);
        pointer += 8n;
        this.#writeU64(pointer, value);
        pointer += 8n;
      }
      this.#setReg(1, sp); // SP
      this.#setReg(7, addressInit); // A0
    }

    /** Runs until the guest yields, exits, or requests supervision.
     * Faults (trap, out of gas) throw, mirroring the native Err path. */
    run() {
      try {
        return this.#run();
      } catch (error) {
        this.dispose();
        throw error;
      }
    }

    dispose() {
      this.devices.dispose();
      if (this.exitStatus === null) this.exitStatus = 130;
    }

    #run() {
      if (this.exitStatus !== null) {
        return { kind: "exited", code: this.exitStatus };
      }
      let status;
      if (this.resumePending) {
        this.resumePending = false;
        this.pvm.pvm_set_gas(this.maxGas);
        status = this.pvm.pvm_resume();
      } else {
        status = this.pvm.pvm_begin(this.startBlock, this.maxGas);
      }
      for (;;) {
        if (status === STATUS_TRAP) {
          throw new Error(
            `computer guest trapped at ${this.pvm.trap_pc.value}`,
          );
        }
        if (status === STATUS_OUT_OF_GAS) {
          throw new Error("computer guest ran out of gas");
        }
        if (status === STATUS_FINISHED) {
          throw new Error("computer guest returned without exiting");
        }
        if (status !== STATUS_ECALL) {
          throw new Error(`translated PolkaVM returned status ${status}`);
        }
        const name = this.metadata.imports[this.pvm.ecall.value >>> 0];
        const outcome = this.#hostcall(name);
        if (outcome === "continue") {
          status = this.pvm.pvm_resume();
          continue;
        }
        this.resumePending = true;
        if (outcome === "yield") {
          return { kind: "yielded" };
        }
        if (outcome === "exit") {
          this.dispose();
          return { kind: "exited", code: this.exitStatus };
        }
        if (outcome === "spawn") {
          return { kind: "spawn" };
        }
        return { kind: "child" };
      }
    }

    /** Completes a suspended process/pipe hostcall with a status value. */
    resolveSpawn(result) {
      this.#setReg(7, BigInt(result));
    }

    /** Completes a suspended pipe_read by delivering bytes. */
    resolveRead(destination, bytes) {
      this.#write(destination, bytes);
      this.#setReg(7, BigInt(bytes.byteLength));
    }

    takeSpawnRequest() {
      const request = this.pendingSpawn;
      this.pendingSpawn = null;
      return request;
    }

    takeChildRequest() {
      const request = this.pendingChildRequest;
      this.pendingChildRequest = null;
      return request;
    }

    sendTerminalInput(bytes) {
      this.devices.pushTerminalInput(bytes);
    }

    takeTerminalOutput() {
      return this.devices.takeTerminalOutput();
    }

    hasTerminalInput() {
      return this.devices.hasTerminalInput();
    }

    terminalInputClosed() {
      return this.devices.ttyInputClosed;
    }

    terminalInputSpace() {
      return this.devices.inputSpace();
    }

    closeTerminalInput() {
      this.devices.closeInput();
    }

    setNetworkEnabled(enabled) {
      this.devices.setNetworkEnabled(enabled);
    }

    setTerminalSize(columns, rows) {
      if (!columns || !rows || columns > 1000 || rows > 1000) {
        throw new Error(`invalid terminal size ${columns}x${rows}`);
      }
      this.devices.ttyColumns = columns;
      this.devices.ttyRows = rows;
    }

    terminalMode() {
      return this.devices.terminalMode();
    }

    mountFile(path, bytes) {
      this.devices.mountFile(path, bytes);
    }

    takeModifiedFiles() {
      return this.devices.takeModifiedFiles();
    }

    takeRemovedFiles() {
      return this.devices.takeRemovedFiles();
    }

    exportFilesystemMetadata() {
      return this.devices.exportFilesystemMetadata();
    }

    importFilesystemMetadata(metadata) {
      this.devices.importFilesystemMetadata(metadata);
    }

    takeFilesystemMetadata() {
      return this.devices.takeFilesystemMetadata();
    }

    // eslint-disable-next-line complexity -- Flat dispatch mirrors the ABI.
    #hostcall(name) {
      const a0 = this.#reg(7);
      const a1 = this.#reg(8);
      const a2 = this.#reg(9);
      const a3 = this.#reg(10);
      switch (name) {
        case "polkadot_host_0_1_core_yield":
          return "yield";
        case "polkadot_host_0_1_core_exit":
          this.exitStatus = Number(BigInt.asIntN(32, a0));
          return "exit";
        case "polkadot_host_0_1_core_args":
          this.#writeRecord(a0, a1, this.encodedArguments);
          return "continue";
        case "polkadot_host_0_1_core_environment":
          this.#writeRecord(a0, a1, this.encodedEnvironment);
          return "continue";
        case "polkadot_host_0_1_core_clock_monotonic": {
          const record = new Uint8Array(8);
          new DataView(record.buffer).setBigUint64(
            0,
            BigInt(Math.floor((performance.now() - this.monotonicEpoch) * 1e6)),
            true,
          );
          this.#write(this.#u32(a0), record);
          this.#setReg(7, 0n);
          return "continue";
        }
        case "polkadot_host_0_1_core_clock_wall": {
          const record = new Uint8Array(8);
          new DataView(record.buffer).setBigUint64(
            0,
            BigInt(Date.now()) * 1_000_000n,
            true,
          );
          this.#write(this.#u32(a0), record);
          this.#setReg(7, 0n);
          return "continue";
        }
        case "polkadot_host_0_1_core_random": {
          const length = this.#u32(a1);
          if (length === 0) {
            this.#setReg(7, BigInt(STATUS_INVALID));
          } else if (length > MAX_RANDOM_BYTES) {
            this.#setReg(7, BigInt(STATUS_LIMIT));
          } else {
            const bytes = new Uint8Array(length);
            crypto.getRandomValues(bytes);
            this.#write(this.#u32(a0), bytes);
            this.#setReg(7, 0n);
          }
          return "continue";
        }
        case "polkadot_host_0_1_tty_current":
          this.#setReg(7, BigInt(COMPUTER_TTY_HANDLE));
          return "continue";
        case "polkadot_host_0_1_tty_read": {
          const capacity = Math.min(this.#u32(a2), MAX_TTY_TRANSFER);
          if (capacity === 0) {
            this.#setReg(7, BigInt(STATUS_INVALID));
            return "continue";
          }
          const result = this.devices.ttyReadInto(this.#u32(a0), capacity);
          if (result.status > 0) {
            this.#write(this.#u32(a1), result.bytes);
          }
          this.#setReg(7, BigInt(result.status));
          return "continue";
        }
        case "polkadot_host_0_1_tty_write": {
          const length = this.#u32(a2);
          if (length > MAX_TTY_TRANSFER) {
            this.#setReg(7, BigInt(STATUS_LIMIT));
            return "continue";
          }
          const bytes = this.#read(this.#u32(a1), length);
          this.#setReg(7, BigInt(this.devices.ttyWrite(this.#u32(a0), bytes)));
          return "continue";
        }
        case "polkadot_host_0_1_tty_get_size": {
          if (this.#u32(a0) !== COMPUTER_TTY_HANDLE) {
            this.#setReg(7, BigInt(STATUS_BAD_HANDLE));
            return "continue";
          }
          const record = new Uint8Array(8);
          const view = new DataView(record.buffer);
          view.setUint32(0, this.devices.ttyColumns, true);
          view.setUint32(4, this.devices.ttyRows, true);
          this.#write(this.#u32(a1), record);
          this.#setReg(7, 0n);
          return "continue";
        }
        case "polkadot_host_0_1_tty_set_mode":
          this.#setReg(
            7,
            BigInt(this.devices.ttySetMode(this.#u32(a0), this.#u32(a1))),
          );
          return "continue";
        case "polkadot_host_0_1_fs_open": {
          const path = this.#readPath(a0, a1);
          this.#setReg(
            7,
            BigInt(
              path === null
                ? STATUS_INVALID
                : this.devices.fsOpen(path, this.#u32(a2)),
            ),
          );
          return "continue";
        }
        case "polkadot_host_0_1_fs_read": {
          const capacity = Math.min(this.#u32(a2), MAX_FS_TRANSFER);
          const result = this.devices.fsRead(this.#u32(a0), capacity);
          if (result.status > 0) {
            this.#write(this.#u32(a1), result.bytes);
          }
          this.#setReg(7, BigInt(result.status));
          return "continue";
        }
        case "polkadot_host_0_1_fs_write": {
          const length = this.#u32(a2);
          if (length > MAX_FS_TRANSFER) {
            this.#setReg(7, BigInt(STATUS_LIMIT));
            return "continue";
          }
          const bytes = this.#read(this.#u32(a1), length);
          this.#setReg(7, BigInt(this.devices.fsWrite(this.#u32(a0), bytes)));
          return "continue";
        }
        case "polkadot_host_0_1_fs_seek":
          this.#setReg(
            7,
            BigInt(
              this.devices.fsSeek(
                this.#u32(a0),
                Number(BigInt.asIntN(32, a1)),
                this.#u32(a2),
              ),
            ),
          );
          return "continue";
        case "polkadot_host_0_1_fs_truncate":
          this.#setReg(
            7,
            BigInt(this.devices.fsTruncate(this.#u32(a0), this.#u32(a1))),
          );
          return "continue";
        case "polkadot_host_0_1_fs_stat": {
          const path = this.#readPath(a0, a1);
          const size = path === null ? null : this.devices.fsStat(path);
          if (size === null) {
            this.#setReg(7, BigInt(STATUS_NOT_FOUND));
            return "continue";
          }
          const record = new Uint8Array(4);
          new DataView(record.buffer).setUint32(0, size, true);
          this.#write(this.#u32(a2), record);
          this.#setReg(7, 0n);
          return "continue";
        }
        case "polkadot_host_0_1_fs_metadata":
        case "polkadot_host_0_1_fs_fstat": {
          const byHandle = name === "polkadot_host_0_1_fs_fstat";
          const result = byHandle
            ? this.devices.fsFstat(this.#u32(a0))
            : this.devices.fsMetadata(this.#readPath(a0, a1));
          if (result.status === 0)
            this.#write(this.#u32(byHandle ? a1 : a2), result.record);
          this.#setReg(7, BigInt(result.status));
          return "continue";
        }
        case "polkadot_host_0_1_fs_mkdir":
        case "polkadot_host_0_1_fs_rmdir": {
          const path = this.#readPath(a0, a1);
          const status =
            name === "polkadot_host_0_1_fs_mkdir"
              ? this.devices.fsMkdir(path)
              : this.devices.fsRmdir(path);
          this.#setReg(7, BigInt(status));
          return "continue";
        }
        case "polkadot_host_0_1_fs_rename":
          this.#setReg(
            7,
            BigInt(
              this.devices.fsRename(
                this.#readPath(a0, a1),
                this.#readPath(a2, a3),
              ),
            ),
          );
          return "continue";
        case "polkadot_host_0_1_fs_list_directory": {
          const result = this.devices.fsListDirectory(this.#readPath(a0, a1));
          if (result.status < 0) this.#setReg(7, BigInt(result.status));
          else if (result.record.byteLength > this.#u32(a3))
            this.#setReg(7, BigInt(-result.record.byteLength));
          else {
            this.#write(this.#u32(a2), result.record);
            this.#setReg(7, BigInt(result.record.byteLength));
          }
          return "continue";
        }
        case "polkadot_host_0_1_fs_sync":
          this.#setReg(7, BigInt(this.devices.fsSync(this.#u32(a0))));
          return "continue";
        case "polkadot_host_0_1_fs_close":
          this.#setReg(7, BigInt(this.devices.fsClose(this.#u32(a0))));
          return "continue";
        case "polkadot_host_0_1_fs_remove": {
          const path = this.#readPath(a0, a1);
          this.#setReg(
            7,
            BigInt(
              path === null ? STATUS_INVALID : this.devices.fsRemove(path),
            ),
          );
          return "continue";
        }
        case "polkadot_host_0_1_fs_list": {
          const capacity = Math.min(this.#u32(a1), MAX_FS_TRANSFER);
          const record = this.devices.fsListRecord();
          if (record.byteLength > capacity) {
            this.#setReg(7, BigInt(-record.byteLength));
          } else {
            this.#write(this.#u32(a0), record);
            this.#setReg(7, BigInt(record.byteLength));
          }
          return "continue";
        }
        case "polkadot_host_0_1_process_run":
        case "polkadot_host_0_1_process_spawn": {
          const pkg = this.#readString(a0, a1, 64);
          const argumentsList =
            pkg === null ? null : this.#readStringRecord(a2, a3);
          if (pkg === null || argumentsList === null) {
            this.#setReg(7, BigInt(STATUS_INVALID));
            return "continue";
          }
          if (name === "polkadot_host_0_1_process_run") {
            this.pendingSpawn = { package: pkg, arguments: argumentsList };
            return "spawn";
          }
          this.pendingChildRequest = {
            kind: "spawn",
            package: pkg,
            arguments: argumentsList,
          };
          return "child";
        }
        case "polkadot_host_0_1_process_wait":
          this.pendingChildRequest = { kind: "wait", pid: this.#u32(a0) };
          return "child";
        case "polkadot_host_0_1_pipe_read": {
          const capacity = Math.min(this.#u32(a2), MAX_TTY_TRANSFER);
          if (capacity === 0) {
            this.#setReg(7, BigInt(STATUS_INVALID));
            return "continue";
          }
          this.pendingChildRequest = {
            kind: "pipeRead",
            pid: this.#u32(a0),
            destination: this.#u32(a1),
            capacity,
          };
          return "child";
        }
        case "polkadot_host_0_1_pipe_write": {
          const length = Math.min(this.#u32(a2), MAX_TTY_TRANSFER);
          const bytes = this.#read(this.#u32(a1), length);
          this.pendingChildRequest = {
            kind: "pipeWrite",
            pid: this.#u32(a0),
            bytes,
          };
          return "child";
        }
        case "polkadot_host_0_1_pipe_close":
          this.pendingChildRequest = { kind: "pipeClose", pid: this.#u32(a0) };
          return "child";
        case "polkadot_host_0_1_workspace_spawn": {
          const a4 = this.#reg(11);
          const a5 = this.#reg(12);
          const pkg = this.#readString(a0, a1, 64);
          const argumentsList =
            pkg === null ? null : this.#readStringRecord(a2, a3);
          if (
            pkg === null ||
            argumentsList === null ||
            a4 > 0xffffffffn ||
            a5 > 0xffffffffn
          ) {
            this.#setReg(7, BigInt(STATUS_INVALID));
            return "continue";
          }
          this.pendingChildRequest = {
            kind: "workspaceSpawn",
            package: pkg,
            arguments: argumentsList,
            columns: this.#u32(a4),
            rows: this.#u32(a5),
          };
          return "child";
        }
        case "polkadot_host_0_1_workspace_send_input": {
          const length = Math.min(this.#u32(a2), MAX_TTY_TRANSFER);
          this.pendingChildRequest = {
            kind: "workspaceSendInput",
            handle: this.#u32(a0),
            bytes: this.#read(this.#u32(a1), length),
          };
          return "child";
        }
        case "polkadot_host_0_1_workspace_read": {
          const capacity = Math.min(this.#u32(a2), MAX_TTY_TRANSFER);
          if (capacity === 0) {
            this.#setReg(7, BigInt(STATUS_INVALID));
            return "continue";
          }
          this.pendingChildRequest = {
            kind: "workspaceRead",
            handle: this.#u32(a0),
            destination: this.#u32(a1),
            capacity,
          };
          return "child";
        }
        case "polkadot_host_0_1_workspace_resize":
          this.pendingChildRequest = {
            kind: "workspaceResize",
            handle: this.#u32(a0),
            columns: this.#u32(a1),
            rows: this.#u32(a2),
          };
          return "child";
        case "polkadot_host_0_1_workspace_wait":
          this.pendingChildRequest = {
            kind: "workspaceWait",
            handle: this.#u32(a0),
          };
          return "child";
        case "polkadot_host_0_1_workspace_close":
          this.pendingChildRequest = {
            kind: "workspaceClose",
            handle: this.#u32(a0),
          };
          return "child";
        case "polkadot_host_0_1_net_tcp_connect": {
          const address = this.#readString(a0, a1, MAX_NET_ADDRESS_BYTES);
          this.#setReg(
            7,
            BigInt(
              address === null
                ? STATUS_INVALID
                : this.devices.netTcpConnect(address),
            ),
          );
          return "continue";
        }
        case "polkadot_host_0_1_net_read": {
          const capacity = Math.min(this.#u32(a2), MAX_TTY_TRANSFER);
          const result = this.devices.netRead(this.#u32(a0), capacity);
          if (result.status > 0) {
            this.#write(this.#u32(a1), result.bytes);
          }
          this.#setReg(7, BigInt(result.status));
          return "continue";
        }
        case "polkadot_host_0_1_net_write": {
          const length = this.#u32(a2);
          if (length > MAX_TTY_TRANSFER) {
            this.#setReg(7, BigInt(STATUS_LIMIT));
          } else {
            this.#setReg(
              7,
              BigInt(
                this.devices.netWrite(
                  this.#u32(a0),
                  this.#read(this.#u32(a1), length),
                ),
              ),
            );
          }
          return "continue";
        }
        case "polkadot_host_0_1_net_close":
          this.#setReg(7, BigInt(this.devices.netClose(this.#u32(a0))));
          return "continue";
        case "host_log": {
          const length = Math.min(this.#u32(a1), 4096);
          if (this.emitLog) {
            try {
              this.emitLog(
                new TextDecoder().decode(this.#read(this.#u32(a0), length)),
              );
            } catch {
              // Diagnostics only.
            }
          }
          return "continue";
        }
        default:
          throw new Error(`unsupported import: ${name}`);
      }
    }

    #writeRecord(pointer, capacity, record) {
      const available = this.#u32(capacity);
      if (record.byteLength > available) {
        this.#setReg(7, BigInt(-record.byteLength));
        return;
      }
      this.#write(this.#u32(pointer), record);
      this.#setReg(7, BigInt(record.byteLength));
    }

    #readPath(pointer, length) {
      return this.#readString(pointer, length, MAX_COMPUTER_PATH_BYTES);
    }

    #readString(pointer, length, maximum) {
      const count = this.#u32(length);
      if (count === 0 || count > maximum) {
        return null;
      }
      try {
        return decoder.decode(this.#read(this.#u32(pointer), count));
      } catch {
        return null;
      }
    }

    #readStringRecord(pointer, length) {
      const count = this.#u32(length);
      if (count > 4096) {
        return null;
      }
      if (count === 0) {
        return [];
      }
      const bytes = this.#read(this.#u32(pointer), count);
      if (bytes.byteLength < 4) {
        return null;
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      const entries = view.getUint32(0, true);
      if (entries > 16) {
        return null;
      }
      const output = [];
      let cursor = 4;
      for (let index = 0; index < entries; index++) {
        if (cursor + 4 > bytes.byteLength) {
          return null;
        }
        const entryLength = view.getUint32(cursor, true);
        cursor += 4;
        if (cursor + entryLength > bytes.byteLength) {
          return null;
        }
        try {
          output.push(
            decoder.decode(bytes.subarray(cursor, cursor + entryLength)),
          );
        } catch {
          return null;
        }
        cursor += entryLength;
      }
      return output;
    }

    #reg(index) {
      return BigInt.asUintN(64, this.pvm[`r${index}`].value);
    }

    #setReg(index, value) {
      this.pvm[`r${index}`].value = this.metadata.is64Bit
        ? BigInt.asIntN(64, value)
        : BigInt.asUintN(32, value);
    }

    #u32(value) {
      return Number(value & 0xffffffffn) >>> 0;
    }

    #range(address, length, write = false) {
      address >>>= 0;
      length >>>= 0;
      const end = address + length;
      if (end > 0x100000000) {
        throw new Error("computer guest memory access is out of range");
      }
      const { layout } = this.metadata;
      let physical;
      if (address >= layout.stackLow && end <= layout.stackHigh) {
        physical = layout.stackPhysical + address - layout.stackLow;
      } else if (
        address >= layout.rwAddress &&
        end <=
          layout.rwAddress + this.memory.buffer.byteLength - layout.rwPhysical
      ) {
        physical = layout.rwPhysical + address - layout.rwAddress;
      } else if (
        !write &&
        address >= layout.roAddress &&
        end <= layout.roAddress + layout.roSize
      ) {
        physical = layout.roPhysical + address - layout.roAddress;
      } else {
        throw new Error("computer guest memory access is out of range");
      }
      return new Uint8Array(this.memory.buffer, physical, length);
    }

    #read(address, length) {
      return this.#range(address, length).slice();
    }

    #write(address, bytes) {
      this.#range(address, bytes.byteLength, true).set(bytes);
    }

    #writeU64(address, value) {
      const bytes = this.#range(Number(address) >>> 0, 8, true);
      new DataView(bytes.buffer, bytes.byteOffset, 8).setBigUint64(
        0,
        BigInt.asUintN(64, value),
        true,
      );
    }
  }

  /** Supervises computer processes sharing one terminal and `/home`
   * (mirror of ComputerSupervisor, including the hardening semantics). */
  class ComputerSupervisor {
    constructor(module, context, maxGas, emitLog = null, options = null) {
      this.packages = new Map();
      this.networkProvider = options?.networkProvider ?? null;
      this.filesystem = options?.filesystem ?? new ComputerFilesystem();
      this.stack = [
        new ComputerProcess(
          module,
          context,
          maxGas,
          emitLog,
          this.networkProvider,
          this.filesystem,
        ),
      ];
      this.background = [];
      this.workspaceChildren = [];
      this.nextPid = 2;
      this.pendingOutput = [];
      this.environment = context.environment.map((pair) => pair.slice());
      this.maxGas = maxGas;
      this.emitLog = emitLog;
      this.network = false;
      this.workspace = false;
      this.columns = 80;
      this.rows = 24;
      // Open spawn: when enabled, a spawn naming an unregistered package
      // suspends the computer with { kind: "package" } instead of failing
      // with NOT_FOUND, so the embedding Host can resolve the name (e.g.
      // through DotNS), then providePackage()/rejectPackage(). Disabled by
      // default: the conformance contract expects immediate NOT_FOUND.
      this.packageResolution = options?.packageResolution === true;
      this.pendingResolution = null;
    }

    /** Registers the pending package and retries the suspended spawn. */
    providePackage(module) {
      const pending = this.pendingResolution;
      if (pending === null) {
        throw new Error("no package resolution is pending");
      }
      this.pendingResolution = null;
      if (pending.mode === "childRoute") {
        // Share the resolution with the whole tree, then route it to the
        // suspended child.
        const child = this.workspaceChildren.find(
          (entry) => entry.handle === pending.handle,
        );
        if (child === undefined) {
          throw new Error("suspended workspace child is gone");
        }
        const name = child.supervisor.pendingPackage();
        if (name !== null) {
          this.registerPackage(name, module);
        }
        child.supervisor.providePackage(module);
        return;
      }
      this.registerPackage(pending.request.package, module);
      this.#dispatchSpawn(pending);
    }

    /** Fails the suspended spawn; the guest observes the status. */
    rejectPackage(status = STATUS_NOT_FOUND) {
      const pending = this.pendingResolution;
      if (pending === null) {
        throw new Error("no package resolution is pending");
      }
      this.pendingResolution = null;
      if (pending.mode === "childRoute") {
        const child = this.workspaceChildren.find(
          (entry) => entry.handle === pending.handle,
        );
        if (child === undefined) {
          throw new Error("suspended workspace child is gone");
        }
        child.supervisor.rejectPackage(status);
        return;
      }
      this.#foreground().resolveSpawn(status);
    }

    /** Returns the package name awaiting embedder resolution, if any. */
    pendingPackage() {
      const pending = this.pendingResolution;
      if (pending === null) {
        return null;
      }
      if (pending.mode === "childRoute") {
        const child = this.workspaceChildren.find(
          (entry) => entry.handle === pending.handle,
        );
        return child ? child.supervisor.pendingPackage() : null;
      }
      return pending.request.package;
    }

    #dispatchSpawn(pending) {
      if (pending.mode === "child") {
        this.#handleChildRequest(pending.request);
        return;
      }
      if (pending.mode === "workspace") {
        this.#handleWorkspaceRequest(pending.request, (value) =>
          this.#foreground().resolveSpawn(value),
        );
        return;
      }
      const child = this.#spawnChild(
        pending.request.package,
        pending.request.arguments,
      );
      if (typeof child === "number") {
        this.#foreground().resolveSpawn(child);
      } else {
        this.stack.push(child);
      }
    }

    #suspendForPackage(request, mode) {
      this.pendingResolution = { request, mode };
      return { kind: "package", package: request.package };
    }

    registerPackage(name, module) {
      if (!name || name.length > 64 || !/^[A-Za-z0-9._-]+$/.test(name)) {
        throw new Error(`invalid package name ${name}`);
      }
      this.packages.set(name, module);
    }

    /** Mounts one persistent file into the shared `/home` store. The mount
     * reaches every live process — foreground stack, piped children, and
     * workspace children — so a file provided after a child spawned (e.g.
     * the seeds of an open-resolved package) is visible tree-wide. */
    mountFile(path, bytes) {
      this.filesystem.mountFile(path, bytes);
    }

    setNetworkEnabled(enabled) {
      if (enabled && this.networkProvider === null) {
        throw new Error("network capability requires a Host network provider");
      }
      for (const process of this.stack) {
        process.setNetworkEnabled(enabled);
      }
      for (const child of this.background) {
        child.process.setNetworkEnabled(enabled);
      }
      for (const child of this.workspaceChildren) {
        child.supervisor.setNetworkEnabled(enabled);
      }
      this.network = enabled;
    }

    /** Grants or revokes the workspace capability for the root process.
     * Revocation reaps every live workspace child. */
    setWorkspaceEnabled(enabled) {
      this.workspace = enabled;
      if (!enabled) {
        for (const child of this.workspaceChildren) child.supervisor.dispose();
        this.workspaceChildren.length = 0;
        if (this.pendingResolution?.mode === "workspace") {
          this.pendingResolution = null;
          this.#foreground().resolveSpawn(STATUS_DENIED);
        } else if (this.pendingResolution?.mode === "childRoute") {
          this.pendingResolution = null;
        }
      }
    }

    setTerminalSize(columns, rows) {
      for (const process of this.stack) {
        process.setTerminalSize(columns, rows);
      }
      for (const child of this.background) {
        child.process.setTerminalSize(columns, rows);
      }
      this.columns = columns;
      this.rows = rows;
    }

    sendTerminalInput(bytes) {
      this.#foreground().sendTerminalInput(bytes);
    }

    terminalInputSpace() {
      return this.#foreground().terminalInputSpace();
    }

    takeTerminalOutput() {
      if (this.pendingOutput.length > 0) {
        const output = Uint8Array.from(this.pendingOutput);
        this.pendingOutput.length = 0;
        return output;
      }
      return this.#foreground().takeTerminalOutput();
    }

    hasTerminalInput() {
      return this.#foreground().hasTerminalInput();
    }

    terminalMode() {
      return this.#foreground().terminalMode();
    }

    takeModifiedFiles() {
      return this.filesystem.takeModifiedFiles();
    }

    takeRemovedFiles() {
      return this.filesystem.takeRemovedFiles();
    }

    exportFilesystemMetadata() {
      return this.filesystem.exportFilesystemMetadata();
    }

    importFilesystemMetadata(metadata) {
      this.filesystem.importFilesystemMetadata(metadata);
    }

    takeFilesystemMetadata() {
      return this.filesystem.takeFilesystemMetadata();
    }

    dispose() {
      for (const process of this.stack) process.dispose();
      for (const child of this.background) child.process.dispose();
      for (const child of this.workspaceChildren) child.supervisor.dispose();
      this.background.length = 0;
      this.workspaceChildren.length = 0;
      this.pendingResolution = null;
    }

    /** Runs the foreground process until the system yields or the root
     * exits; child faults fail only the child (status 139). */
    run() {
      try {
        return this.#run();
      } catch (error) {
        this.dispose();
        throw error;
      }
    }


    #run() {
      if (this.pendingResolution !== null) {
        // Idempotent while suspended: the embedder must provide or reject
        // the pending package before execution can continue.
        return { kind: "package", package: this.pendingPackage() };
      }
      let faultPops = 0;
      for (;;) {
        let status;
        try {
          status = this.#foreground().run();
        } catch (error) {
          if (this.stack.length === 1) {
            throw error;
          }
          faultPops++;
          if (faultPops > MAX_FAULT_POPS_PER_RUN) {
            throw new Error(`children faulted repeatedly: ${error.message}`);
          }
          this.#popForeground(FAULTED_CHILD_STATUS);
          continue;
        }
        if (status.kind === "yielded") {
          // Surface a suspended workspace child's resolution once the
          // workspace guest has yielded; the embedder resolves it before
          // execution continues anywhere in the tree.
          const suspended = this.workspaceChildren.find(
            (child) =>
              child.exit === null && child.supervisor.pendingPackage() !== null,
          );
          if (suspended !== undefined) {
            this.pendingResolution = {
              mode: "childRoute",
              handle: suspended.handle,
            };
            return { kind: "package", package: this.pendingPackage() };
          }
          return { kind: "yielded" };
        }
        if (status.kind === "spawn") {
          const request = this.#foreground().takeSpawnRequest();
          if (!request) {
            throw new Error("spawn status without a pending request");
          }
          const child = this.#spawnChild(request.package, request.arguments);
          if (child === STATUS_NOT_FOUND && this.packageResolution) {
            return this.#suspendForPackage(request, "stack");
          }
          if (typeof child === "number") {
            this.#foreground().resolveSpawn(child);
          } else {
            this.stack.push(child);
          }
          continue;
        }
        if (status.kind === "child") {
          const request = this.#foreground().takeChildRequest();
          if (!request) {
            throw new Error("child-request status without a pending request");
          }
          this.#handleChildRequest(request);
          if (this.pendingResolution !== null) {
            return { kind: "package", package: this.pendingPackage() };
          }
          continue;
        }
        // Exited.
        if (this.stack.length === 1) {
          this.dispose();
          return { kind: "exited", code: status.code };
        }
        this.#popForeground(status.code & 0xff);
      }
    }

    /** Host-authority cancellation of the foreground process. */
    terminateForeground() {
      if (this.stack.length === 1) {
        const root = this.#foreground();
        if (root.exitStatus === null) {
          root.exitStatus = 130;
        }
        this.dispose();
        return { kind: "exited", code: root.exitStatus };
      }
      this.pendingResolution = null;
      this.#popForeground(130);
      return { kind: "yielded" };
    }

    #foreground() {
      return this.stack[this.stack.length - 1];
    }

    #appendPendingOutput(bytes) {
      const available = MAX_TTY_OUTPUT_BYTES - this.pendingOutput.length;
      const count = Math.min(bytes.byteLength, Math.max(0, available));
      for (let index = 0; index < count; index++) {
        this.pendingOutput.push(bytes[index]);
      }
    }

    #popForeground(status) {
      const child = this.stack.pop();
      child.dispose();
      // Preserve terminal write order: parent bytes before the child's.
      const parentOutput = this.#foreground().takeTerminalOutput();
      if (parentOutput) {
        this.#appendPendingOutput(parentOutput);
      }
      const childOutput = child.takeTerminalOutput();
      if (childOutput) {
        this.#appendPendingOutput(childOutput);
      }
      const depth = this.stack.length;
      this.background = this.background.filter((entry) => {
        if (entry.owner <= depth) return true;
        entry.process.dispose();
        return false;
      });
      this.#foreground().resolveSpawn(status);
    }

    #spawnChild(pkg, argumentsList) {
      if (this.stack.length >= MAX_COMPUTER_PROCESSES) {
        return STATUS_LIMIT;
      }
      const module = this.packages.get(pkg);
      if (module === undefined) {
        return STATUS_NOT_FOUND;
      }
      let context;
      try {
        context = computerContext([pkg, ...argumentsList], this.environment);
      } catch {
        return STATUS_INVALID;
      }
      let child;
      try {
        child = new ComputerProcess(
          module,
          context,
          this.maxGas,
          this.emitLog,
          this.networkProvider,
          this.filesystem,
        );
        child.setTerminalSize(this.columns, this.rows);
        child.setNetworkEnabled(this.network);
      } catch {
        child?.dispose();
        return STATUS_INVALID;
      }
      return child;
    }

    #backgroundIndex(pid) {
      const depth = this.stack.length;
      return this.background.findIndex(
        (entry) => entry.pid === pid && entry.owner === depth,
      );
    }

    #handleChildRequest(request) {
      const resolve = (value) => this.#foreground().resolveSpawn(value);
      if (request.kind.startsWith("workspace")) {
        // Only the root computer holding the workspace grant may manage
        // children; nested computers are never granted it.
        if (!this.workspace || this.stack.length !== 1) {
          resolve(STATUS_DENIED);
          return;
        }
        this.#handleWorkspaceRequest(request, resolve);
        return;
      }
      if (request.kind === "spawn") {
        if (this.background.length >= MAX_BACKGROUND_PROCESSES) {
          resolve(STATUS_LIMIT);
          return;
        }
        const child = this.#spawnChild(request.package, request.arguments);
        if (child === STATUS_NOT_FOUND && this.packageResolution) {
          this.#suspendForPackage(request, "child");
          return;
        }
        if (typeof child === "number") {
          resolve(child);
          return;
        }
        const pid = this.nextPid++;
        this.background.push({
          pid,
          owner: this.stack.length,
          process: child,
          output: [],
          exit: null,
        });
        resolve(pid);
        return;
      }
      const index = this.#backgroundIndex(request.pid);
      if (index < 0) {
        resolve(STATUS_BAD_HANDLE);
        return;
      }
      const entry = this.background[index];
      if (request.kind === "wait") {
        this.#driveBackground(entry);
        if (entry.exit !== null) {
          this.background.splice(index, 1);
          resolve(entry.exit & 0xff);
        } else {
          resolve(STATUS_WOULD_BLOCK);
        }
        return;
      }
      if (request.kind === "pipeWrite") {
        if (entry.exit !== null || entry.process.terminalInputClosed()) {
          resolve(STATUS_INVALID);
          return;
        }
        const space = entry.process.terminalInputSpace();
        const written = Math.min(request.bytes.byteLength, space);
        if (written > 0) {
          entry.process.sendTerminalInput(request.bytes.subarray(0, written));
        }
        this.#driveBackground(entry);
        resolve(written);
        return;
      }
      if (request.kind === "pipeRead") {
        if (entry.output.length === 0) {
          this.#driveBackground(entry);
        }
        if (entry.output.length > 0) {
          const count = Math.min(entry.output.length, request.capacity);
          const bytes = Uint8Array.from(entry.output.slice(0, count));
          entry.output.splice(0, count);
          this.#foreground().resolveRead(request.destination, bytes);
        } else if (entry.exit !== null) {
          resolve(0);
        } else {
          resolve(STATUS_WOULD_BLOCK);
        }
        return;
      }
      // pipeClose
      entry.process.closeTerminalInput();
      this.#driveBackground(entry);
      resolve(0);
    }

    #driveBackground(entry) {
      for (let step = 0; step < MAX_DRIVE_STEPS; step++) {
        if (entry.exit !== null) {
          return;
        }
        let status = null;
        try {
          status = entry.process.run();
        } catch {
          // A faulted piped child fails alone; final output and file
          // writes are still collected below.
        }
        const output = entry.process.takeTerminalOutput();
        if (output) {
          const available = MAX_TTY_OUTPUT_BYTES - entry.output.length;
          const count = Math.min(output.byteLength, Math.max(0, available));
          for (let index = 0; index < count; index++) {
            entry.output.push(output[index]);
          }
        }
        if (status === null) {
          entry.exit = FAULTED_CHILD_STATUS;
          return;
        }
        if (status.kind === "exited") {
          entry.exit = status.code & 0xff;
          return;
        }
        if (status.kind === "yielded") {
          if (!entry.process.hasTerminalInput()) {
            return;
          }
          continue;
        }
        // Background children cannot own the terminal or spawn.
        if (status.kind === "spawn") {
          entry.process.takeSpawnRequest();
        } else {
          entry.process.takeChildRequest();
        }
        entry.process.resolveSpawn(STATUS_DENIED);
      }
    }

    /** Executes one workspace operation and resolves it into the root
     * guest (mirror of handle_workspace_request). */
    #handleWorkspaceRequest(request, resolve) {
      if (request.kind === "workspaceSpawn") {
        if (this.workspaceChildren.length >= MAX_WORKSPACE_CHILDREN) {
          resolve(STATUS_LIMIT);
          return;
        }
        if (this.packageResolution && !this.packages.has(request.package)) {
          this.#suspendForPackage(request, "workspace");
          return;
        }
        resolve(
          this.#spawnWorkspaceChild(
            request.package,
            request.arguments,
            request.columns,
            request.rows,
          ),
        );
        return;
      }
      const index = this.#workspaceIndex(request.handle);
      if (index < 0) {
        resolve(STATUS_BAD_HANDLE);
        return;
      }
      const child = this.workspaceChildren[index];
      if (request.kind === "workspaceSendInput") {
        if (child.exit !== null) {
          resolve(STATUS_INVALID);
          return;
        }
        const space = child.supervisor.terminalInputSpace();
        const written = Math.min(request.bytes.byteLength, space);
        if (written > 0) {
          child.supervisor.sendTerminalInput(
            request.bytes.subarray(0, written),
          );
        }
        this.#driveWorkspaceChild(index);
        resolve(written);
        return;
      }
      if (request.kind === "workspaceRead") {
        if (child.output.length === 0) {
          this.#driveWorkspaceChild(index);
        }
        if (child.output.length > 0) {
          const count = Math.min(child.output.length, request.capacity);
          const bytes = Uint8Array.from(child.output.slice(0, count));
          child.output.splice(0, count);
          this.#foreground().resolveRead(request.destination, bytes);
        } else if (child.exit !== null) {
          resolve(0);
        } else {
          resolve(STATUS_WOULD_BLOCK);
        }
        return;
      }
      if (request.kind === "workspaceResize") {
        if (child.exit !== null) {
          resolve(STATUS_INVALID);
          return;
        }
        try {
          child.supervisor.setTerminalSize(request.columns, request.rows);
        } catch {
          resolve(STATUS_INVALID);
          return;
        }
        resolve(0);
        return;
      }
      if (request.kind === "workspaceWait") {
        this.#driveWorkspaceChild(index);
        // The handle stays valid after exit so remaining output can be
        // drained; workspace_close reclaims the slot.
        resolve(child.exit !== null ? child.exit & 0xff : STATUS_WOULD_BLOCK);
        return;
      }
      // Closing a workspace cancels all of its processes and releases handles.
      child.supervisor.dispose();
      this.workspaceChildren.splice(index, 1);
      resolve(0);
    }

    /** Resolves a workspace child handle to its slot. */
    #workspaceIndex(handle) {
      return this.workspaceChildren.findIndex(
        (child) => child.handle === handle,
      );
    }

    /** Runs a workspace child until it exits or blocks awaiting input,
     * collecting its terminal output; filesystem changes are already shared.
     *
     * Cooperative scheduling: workspace children only execute while the
     * workspace guest is suspended inside a workspace hostcall. */
    #driveWorkspaceChild(index) {
      for (let step = 0; step < MAX_WORKSPACE_DRIVE_STEPS; step++) {
        const child = this.workspaceChildren[index];
        if (child.exit !== null) {
          return;
        }
        // A faulted child fails alone; the workspace observes the fault
        // status through wait. Its final output and writes still land.
        let outcome = null;
        try {
          outcome = child.supervisor.run();
        } catch {
          // Fault: reported below as FAULTED_CHILD_STATUS.
        }
        for (
          let output = child.supervisor.takeTerminalOutput();
          output !== null;
          output = child.supervisor.takeTerminalOutput()
        ) {
          const available = MAX_TTY_OUTPUT_BYTES - child.output.length;
          const count = Math.min(output.byteLength, Math.max(0, available));
          for (let offset = 0; offset < count; offset++) {
            child.output.push(output[offset]);
          }
        }
        let exit = null;
        if (outcome === null) {
          exit = FAULTED_CHILD_STATUS;
        } else if (outcome.kind === "exited") {
          exit = outcome.code & 0xff;
        } else if (outcome.kind === "package") {
          // A suspended package resolution surfaces at the parent's next
          // yielded return; stop driving without progress.
          return;
        } else if (outcome.kind !== "yielded") {
          // A nested supervisor only surfaces yielded, exited, or package.
          exit = FAULTED_CHILD_STATUS;
        }
        if (exit !== null) {
          child.supervisor.dispose();
          child.exit = exit;
          return;
        }
        if (!child.supervisor.hasTerminalInput()) {
          return;
        }
      }
    }

    /** Launches an independently supervised workspace child: a complete
     * nested computer whose terminal endpoint is the parent-held handle. */
    #spawnWorkspaceChild(pkg, argumentsList, columns, rows) {
      if (columns < 1 || columns > 1000 || rows < 1 || rows > 1000) {
        return STATUS_INVALID;
      }
      const module = this.packages.get(pkg);
      if (module === undefined) {
        return STATUS_NOT_FOUND;
      }
      let child;
      try {
        const context = computerContext(
          [pkg, ...argumentsList],
          this.environment,
        );
        child = new ComputerSupervisor(
          module,
          context,
          this.maxGas,
          this.emitLog,
          {
            networkProvider: this.networkProvider,
            packageResolution: this.packageResolution,
            filesystem: this.filesystem,
          },
        );
        // The nested computer shares the Host-authorized package registry
        // so a shell pane can run editors; it is never granted
        // host.workspace.
        child.packages = new Map(this.packages);
        child.setTerminalSize(columns, rows);
        child.setNetworkEnabled(this.network);
      } catch {
        child?.dispose();
        return STATUS_INVALID;
      }
      const handle = this.nextPid++;
      this.workspaceChildren.push({
        handle,
        supervisor: child,
        output: [],
        exit: null,
      });
      return handle;
    }
  }

  /** Translates a `.polkavm` program to a wasm module through the staged
   * translator in pvm-browser-runtime.wasm. */
  class ComputerTranslator {
    constructor(runtimeExports) {
      this.pvm = runtimeExports;
    }

    static async create(runtimeWasm) {
      const { instance } =
        runtimeWasm instanceof WebAssembly.Module
          ? { instance: new WebAssembly.Instance(runtimeWasm, {}) }
          : await WebAssembly.instantiate(runtimeWasm, {});
      const exports = instance.exports;
      if (exports.pvm_browser_abi_version() !== 1) {
        throw new Error("PolkaVM browser runtime ABI mismatch");
      }
      return new ComputerTranslator(exports);
    }

    #errorText() {
      const pointer = this.pvm.pvm_browser_error_pointer();
      const length = this.pvm.pvm_browser_error_length();
      return new TextDecoder().decode(
        new Uint8Array(this.pvm.memory.buffer, pointer, length),
      );
    }

    async translate(programBytes) {
      const source =
        programBytes instanceof Uint8Array
          ? programBytes
          : new Uint8Array(programBytes);
      const pointer = this.pvm.pvm_browser_staging_reserve(source.byteLength);
      if (!pointer) {
        throw new Error(`reserve staging memory: ${this.#errorText()}`);
      }
      new Uint8Array(this.pvm.memory.buffer, pointer, source.byteLength).set(
        source,
      );
      if (this.pvm.pvm_browser_translate_staged() !== 0) {
        throw new Error(`translate computer guest: ${this.#errorText()}`);
      }
      const output = this.pvm.pvm_browser_translation_pointer();
      const length = this.pvm.pvm_browser_translation_length();
      const bytes = new Uint8Array(
        this.pvm.memory.buffer,
        output,
        length,
      ).slice();
      return WebAssembly.compile(bytes);
    }
  }

  globalThis.PvmComputer = {
    computerContext,
    ComputerDevices,
    ComputerProcess,
    ComputerSupervisor,
    ComputerTranslator,
    WebSocketTcpProvider,
    STATUS_WOULD_BLOCK,
    STATUS_BAD_HANDLE,
    STATUS_INVALID,
    STATUS_NOT_FOUND,
    STATUS_DENIED,
    STATUS_LIMIT,
    STATUS_EXISTS,
    STATUS_NOT_DIRECTORY,
    STATUS_IS_DIRECTORY,
    STATUS_NOT_EMPTY,
    FS_OPEN_READ,
    FS_OPEN_WRITE,
    FS_OPEN_CREATE,
    FS_OPEN_TRUNCATE,
    FS_OPEN_EXCLUSIVE,
    FS_OPEN_APPEND,
    TTY_MODE_RAW,
    TTY_MODE_ECHO,
  };
})();
