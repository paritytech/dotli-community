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

  const COMPUTER_TTY_HANDLE = 1;
  const TTY_MODE_RAW = 1;
  const TTY_MODE_ECHO = 2;
  const MAX_TTY_INPUT_BYTES = 64 * 1024;
  const MAX_TTY_OUTPUT_BYTES = 1024 * 1024;
  const MAX_COMPUTER_FILES = 64;
  const MAX_COMPUTER_FILE_BYTES = 1024 * 1024;
  const MAX_OPEN_COMPUTER_FILES = 16;
  const MAX_COMPUTER_PATH_BYTES = 200;
  const MAX_COMPUTER_CONTEXT_BYTES = 64 * 1024;
  const MAX_COMPUTER_CONTEXT_ENTRIES = 1024;
  const MAX_COMPUTER_PROCESSES = 4;
  const MAX_BACKGROUND_PROCESSES = 4;
  const FIRST_FILE_HANDLE = 16;
  const MAX_TTY_TRANSFER = 64 * 1024;
  const MAX_RANDOM_BYTES = 4 * 1024;
  const MAX_OPEN_SOCKETS = 4;
  const FIRST_SOCKET_HANDLE = 0x1000;
  const MAX_NET_ADDRESS_BYTES = 256;
  const MAX_FS_TRANSFER = 1024 * 1024;
  const FS_OPEN_READ = 1;
  const FS_OPEN_WRITE = 2;
  const FS_OPEN_CREATE = 4;
  const FS_OPEN_TRUNCATE = 8;
  const FAULTED_CHILD_STATUS = 139;
  const MAX_FAULT_POPS_PER_RUN = 32;
  const MAX_DRIVE_STEPS = 1024;
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
      encoder.encode(path).byteLength > MAX_COMPUTER_PATH_BYTES ||
      !path.startsWith("/home/") ||
      path.endsWith("/") ||
      path.includes("\0") ||
      path
        .split("/")
        .some((segment) => segment === "." || segment === "..")
    ) {
      return null;
    }
    return path;
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
      this.connected = false;
      this.closed = false;
      this.onActivity = onActivity;
      this.socket = new WebSocketClass(relayUrl);
      this.socket.binaryType = "arraybuffer";
      this.socket.onopen = () => {
        this.socket.send(JSON.stringify({ version: 1, address }));
      };
      this.socket.onmessage = (event) => {
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
        if (bytes.byteLength > 0) {
          this.incoming.push(bytes.slice());
        }
        this.#activity();
      };
      this.socket.onclose = () => this.#terminate();
      this.socket.onerror = () => this.#terminate();
    }

    read(capacity) {
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
      if (this.socket.bufferedAmount > 1024 * 1024) {
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
    constructor(networkProvider = null) {
      this.ttyInput = [];
      this.ttyInputClosed = false;
      this.ttyOutput = [];
      this.ttyColumns = 80;
      this.ttyRows = 24;
      this.ttyMode = TTY_MODE_ECHO;
      this.files = new Map();
      this.modified = new Set();
      this.removed = new Set();
      this.openFiles = new Map();
      this.networkProvider = networkProvider;
      this.networkEnabled = false;
      this.sockets = new Map();
      this.nextSocket = FIRST_SOCKET_HANDLE;
    }

    setNetworkEnabled(enabled) {
      this.networkEnabled = enabled;
      if (!enabled) {
        for (const socket of this.sockets.values()) {
          socket.close();
        }
        this.sockets.clear();
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
      socket.close();
      return 0;
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
      if (validPath(path) === null) {
        throw new Error(`invalid computer file path ${path}`);
      }
      if (bytes.byteLength > MAX_COMPUTER_FILE_BYTES) {
        throw new Error(`mounted file ${path} exceeds the size limit`);
      }
      if (!this.files.has(path) && this.files.size === MAX_COMPUTER_FILES) {
        throw new Error("computer filesystem file limit exceeded");
      }
      this.files.set(path, Uint8Array.from(bytes));
      this.removed.delete(path);
    }

    takeModifiedFiles() {
      const changed = [];
      for (const path of this.modified) {
        const bytes = this.files.get(path);
        if (bytes !== undefined) {
          changed.push([path, bytes.slice()]);
        }
      }
      this.modified.clear();
      return changed;
    }

    takeRemovedFiles() {
      const removed = [...this.removed];
      this.removed.clear();
      return removed;
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
      if (validPath(path) === null) {
        return STATUS_INVALID;
      }
      const readable = (flags & FS_OPEN_READ) !== 0;
      const writable = (flags & FS_OPEN_WRITE) !== 0;
      if (!readable && !writable) {
        return STATUS_INVALID;
      }
      if (this.openFiles.size === MAX_OPEN_COMPUTER_FILES) {
        return STATUS_LIMIT;
      }
      if (!this.files.has(path)) {
        if (!(writable && (flags & FS_OPEN_CREATE) !== 0)) {
          return STATUS_NOT_FOUND;
        }
        if (this.files.size === MAX_COMPUTER_FILES) {
          return STATUS_LIMIT;
        }
      }
      let handle = FIRST_FILE_HANDLE;
      while (this.openFiles.has(handle)) {
        handle++;
      }
      if (
        !this.files.has(path) ||
        (writable && (flags & FS_OPEN_TRUNCATE) !== 0)
      ) {
        this.files.set(path, new Uint8Array(0));
        this.modified.add(path);
        this.removed.delete(path);
      }
      this.openFiles.set(handle, { path, position: 0, readable, writable });
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
      const end = open.position + bytes.byteLength;
      if (end > MAX_COMPUTER_FILE_BYTES) {
        return STATUS_LIMIT;
      }
      let next = file;
      if (file.byteLength < end) {
        next = new Uint8Array(end);
        next.set(file);
        this.files.set(open.path, next);
      }
      next.set(bytes, open.position);
      open.position = end;
      this.modified.add(open.path);
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
      const next = new Uint8Array(length);
      next.set(file.subarray(0, Math.min(length, file.byteLength)));
      this.files.set(open.path, next);
      this.modified.add(open.path);
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
      return this.openFiles.delete(handle) ? 0 : STATUS_BAD_HANDLE;
    }

    fsRemove(path) {
      if (validPath(path) === null) {
        return STATUS_INVALID;
      }
      for (const open of this.openFiles.values()) {
        if (open.path === path) {
          return STATUS_DENIED;
        }
      }
      if (!this.files.delete(path)) {
        return STATUS_NOT_FOUND;
      }
      this.modified.delete(path);
      this.removed.add(path);
      return 0;
    }

    fsListRecord() {
      const paths = [...this.files.keys()].sort();
      return encodeStringRecord(paths);
    }
  }

  /** One translated computer guest process (mirror of ComputerRuntime). */
  class ComputerProcess {
    constructor(module, context, maxGas, emitLog = null, networkProvider = null) {
      this.metadata = readMetadata(module);
      this.instance = new WebAssembly.Instance(module, {});
      this.pvm = this.instance.exports;
      this.memory = this.pvm.memory;
      this.maxGas = BigInt(maxGas);
      this.emitLog = emitLog;
      this.devices = new ComputerDevices(networkProvider);
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
            BigInt(
              Math.floor((performance.now() - this.monotonicEpoch) * 1e6),
            ),
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
            BigInt(path === null ? STATUS_INVALID : this.devices.fsRemove(path)),
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
      this.stack = [
        new ComputerProcess(
          module,
          context,
          maxGas,
          emitLog,
          this.networkProvider,
        ),
      ];
      this.background = [];
      this.nextPid = 2;
      this.pendingOutput = [];
      this.environment = context.environment.map((pair) => pair.slice());
      this.files = new Map();
      this.modified = new Map();
      this.removed = new Set();
      this.maxGas = maxGas;
      this.emitLog = emitLog;
      this.network = false;
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
      this.#foreground().resolveSpawn(status);
    }

    #dispatchSpawn(pending) {
      if (pending.mode === "child") {
        this.#handleChildRequest(pending.request);
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
      if (
        !name ||
        name.length > 64 ||
        !/^[A-Za-z0-9._-]+$/.test(name)
      ) {
        throw new Error(`invalid package name ${name}`);
      }
      this.packages.set(name, module);
    }

    mountFile(path, bytes) {
      this.#foreground().mountFile(path, bytes);
      this.files.set(path, Uint8Array.from(bytes));
      this.removed.delete(path);
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
      this.network = enabled;
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
      const changed = [...this.modified.entries()];
      this.modified.clear();
      return changed;
    }

    takeRemovedFiles() {
      const removed = [...this.removed];
      this.removed.clear();
      return removed;
    }

    /** Runs the foreground process until the system yields or the root
     * exits; child faults fail only the child (status 139). */
    run() {
      if (this.pendingResolution !== null) {
        // Idempotent while suspended: the embedder must provide or reject
        // the pending package before execution can continue.
        return {
          kind: "package",
          package: this.pendingResolution.request.package,
        };
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
        this.#collectModified();
        if (status.kind === "yielded") {
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
            return {
              kind: "package",
              package: this.pendingResolution.request.package,
            };
          }
          continue;
        }
        // Exited.
        if (this.stack.length === 1) {
          return { kind: "exited", code: status.code };
        }
        this.#popForeground(status.code & 0xff);
      }
    }

    /** Host-authority cancellation of the foreground process. */
    terminateForeground() {
      this.#collectModified();
      if (this.stack.length === 1) {
        const root = this.#foreground();
        if (root.exitStatus === null) {
          root.exitStatus = 130;
        }
        this.background.length = 0;
        return { kind: "exited", code: root.exitStatus };
      }
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
      this.background = this.background.filter(
        (entry) => entry.owner <= depth,
      );
      this.#foreground().resolveSpawn(status);
      for (const [path, bytes] of this.files) {
        this.#foreground().mountFile(path, bytes);
      }
    }

    #collectModified() {
      for (const path of this.#foreground().takeRemovedFiles()) {
        this.files.delete(path);
        this.modified.delete(path);
        this.removed.add(path);
      }
      for (const [path, bytes] of this.#foreground().takeModifiedFiles()) {
        this.files.set(path, bytes);
        this.modified.set(path, bytes.slice());
        this.removed.delete(path);
      }
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
        );
        child.setNetworkEnabled(this.network);
        for (const [path, bytes] of this.files) {
          child.mountFile(path, bytes);
        }
      } catch {
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
          for (const [path, bytes] of this.files) {
            this.#foreground().mountFile(path, bytes);
          }
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
        for (const path of entry.process.takeRemovedFiles()) {
          this.files.delete(path);
          this.modified.delete(path);
          this.removed.add(path);
        }
        for (const [path, bytes] of entry.process.takeModifiedFiles()) {
          this.files.set(path, bytes);
          this.modified.set(path, bytes.slice());
          this.removed.delete(path);
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
    TTY_MODE_RAW,
    TTY_MODE_ECHO,
  };
})();
