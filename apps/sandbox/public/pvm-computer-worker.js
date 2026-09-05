// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Hosts the experimental `polkadot-host-computer/0.1` supervisor off the
// main thread. The page owns the DOM terminal; this worker owns every VM.
// Protocol (structured clone, buffers transferred where possible):
//   page -> worker:
//     { type: "start", runtime, program, packages: [{ name, bytes }],
//       files: [{ path, bytes }], argv, environment, columns, rows, maxGas }
//     { type: "package", name, bytes, files } resolved child program and seeds
//     { type: "resize", columns, rows }
//   worker -> page:
//     { type: "started", translationMs }
//     { type: "output", bytes }            terminal ANSI byte stream
//     { type: "files", entries, removed }  changed /home entries
//     { type: "log", message }             guest host_log diagnostics
//     { type: "error", message }           supervisor fault; computer is dead

importScripts(
  new URL("/pvm-runtime/pvm-computer.js", self.location.origin).href,
);

const {
  ComputerSupervisor,
  ComputerTranslator,
  WebSocketTcpProvider,
  computerContext,
} = globalThis.PvmComputer;

// One pump handles at most this many run slices before declaring the guest
// wedged. A busy full-screen redraw needs a few dozen; 100k is a hang.
const MAX_SLICES_PER_PUMP = 100_000;

let supervisor = null;
let finished = false;
// Input the guest's bounded queue could not accept yet (large pastes).
const pendingInput = [];
const pendingNetworkPermissions = new Map();
let nextNetworkPermission = 0;

class PermissionTcpSocket {
  constructor(provider, address, activity) {
    this.provider = provider;
    this.address = address;
    this.activity = activity;
    this.socket = null;
    this.denied = false;
    this.closed = false;
  }

  resolve(granted) {
    if (this.closed) {
      return;
    }
    if (granted) {
      this.socket = this.provider.connect(this.address);
    } else {
      this.denied = true;
      this.activity();
    }
  }

  read(capacity) {
    if (this.denied) {
      // The browser runtime catches Errors from socket.read() and maps
      // them to STATUS_INVALID; set denied flag so the runtime returns
      // STATUS_DENIED (EACCES) instead.
      return null;
    }
    return this.socket === null ? null : this.socket.read(capacity);
  }

  write(bytes) {
    if (this.denied) {
      return null;
    }
    return this.socket === null ? null : this.socket.write(bytes);
  }

  close() {
    this.closed = true;
    this.socket?.close();
  }
}

class PermissionTcpProvider {
  constructor(provider, activity) {
    this.provider = provider;
    this.activity = activity;
  }

  connect(address) {
    const separator = address.lastIndexOf(":");
    const domain = address.slice(0, separator).toLowerCase();
    if (
      separator <= 0 ||
      address.indexOf(":") !== separator ||
      !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)
    ) {
      throw new Error("invalid network target");
    }
    const socket = new PermissionTcpSocket(
      this.provider,
      address,
      this.activity,
    );
    const nonce = `network-${String(nextNetworkPermission++)}`;
    pendingNetworkPermissions.set(nonce, socket);
    self.postMessage({ type: "network-permission", nonce, domain });
    return socket;
  }
}

function fail(error) {
  finished = true;
  self.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
}

function drainOutput() {
  const output = supervisor.takeTerminalOutput();
  if (output !== null && output.byteLength > 0) {
    self.postMessage({ type: "output", bytes: output }, [output.buffer]);
  }
  const entries = supervisor.takeModifiedFiles();
  if (entries.length > 0) {
    self.postMessage(
      {
        type: "files",
        entries: entries.map(([path, bytes]) => ({ path, bytes })),
      },
      entries.map(([, bytes]) => bytes.buffer),
    );
  }
  const removed = supervisor.takeRemovedFiles();
  if (removed.length > 0) {
    self.postMessage({ type: "files", entries: [], removed });
  }
}

function flushPendingInput() {
  while (pendingInput.length > 0) {
    const space = supervisor.terminalInputSpace();
    if (space === 0) {
      return;
    }
    const next = pendingInput[0];
    if (next.byteLength <= space) {
      supervisor.sendTerminalInput(next);
      pendingInput.shift();
    } else {
      supervisor.sendTerminalInput(next.subarray(0, space));
      pendingInput[0] = next.subarray(space);
    }
  }
}

let translator = null;
// Package name whose resolution the page currently owns; pump() stays
// suspended until a "package"/"package-error" message settles it.
let resolvingPackage = null;

function pump() {
  if (supervisor === null || finished || resolvingPackage !== null) {
    return;
  }
  try {
    for (let slice = 0; slice < MAX_SLICES_PER_PUMP; slice += 1) {
      flushPendingInput();
      const status = supervisor.run();
      drainOutput();
      if (status.kind === "exited") {
        finished = true;
        self.postMessage({ type: "exit", code: status.code });
        return;
      }
      if (status.kind === "package") {
        // Open spawn: ask the page to resolve the name (DotNS) and hand
        // back program bytes; the computer stays suspended meanwhile.
        resolvingPackage = status.package;
        self.postMessage({ type: "resolve-package", name: status.package });
        return;
      }
      if (!supervisor.hasTerminalInput() && pendingInput.length === 0) {
        return;
      }
    }
    throw new Error("computer kept running without settling");
  } catch (error) {
    fail(error);
  }
}

async function providePackage(message) {
  for (const file of message.files ?? []) {
    supervisor.mountFile(file.path, new Uint8Array(file.bytes));
  }
  const module = await translator.translate(message.bytes);
  supervisor.providePackage(module);
  resolvingPackage = null;
  pump();
}

async function start(message) {
  translator = await ComputerTranslator.create(message.runtime);
  const started = performance.now();
  const program = await translator.translate(message.program);
  const context = computerContext(message.argv, message.environment);
  const networkActivity = () => {
    queueMicrotask(pump);
  };
  const networkProvider = message.networkEnabled
    ? new PermissionTcpProvider(
        new WebSocketTcpProvider(message.relayUrl, networkActivity),
        networkActivity,
      )
    : null;
  supervisor = new ComputerSupervisor(
    program,
    context,
    message.maxGas,
    (text) => {
      self.postMessage({ type: "log", message: text });
    },
    { packageResolution: true, networkProvider },
  );
  for (const entry of message.packages) {
    supervisor.registerPackage(
      entry.name,
      await translator.translate(entry.bytes),
    );
  }
  supervisor.setNetworkEnabled(message.networkEnabled === true);
  supervisor.setTerminalSize(message.columns, message.rows);
  for (const file of message.files) {
    supervisor.mountFile(file.path, new Uint8Array(file.bytes));
  }
  self.postMessage({
    type: "started",
    translationMs: performance.now() - started,
  });
  pump();
}

self.onmessage = (event) => {
  const message = event.data;
  try {
    switch (message.type) {
      case "start": {
        if (supervisor !== null) {
          throw new Error("computer already started");
        }
        start(message).catch(fail);
        break;
      }
      case "input": {
        if (supervisor !== null && !finished) {
          pendingInput.push(new Uint8Array(message.bytes));
          pump();
        }
        break;
      }
      case "resize": {
        if (supervisor !== null && !finished) {
          supervisor.setTerminalSize(message.columns, message.rows);
          pump();
        }
        break;
      }
      case "package": {
        if (supervisor !== null && !finished) {
          if (message.name !== resolvingPackage) {
            throw new Error(`unexpected package ${message.name}`);
          }
          providePackage(message).catch(fail);
        }
        break;
      }
      case "network-permission-result": {
        const socket = pendingNetworkPermissions.get(message.nonce);
        if (socket === undefined) {
          throw new Error(`unexpected network permission ${message.nonce}`);
        }
        pendingNetworkPermissions.delete(message.nonce);
        socket.resolve(message.granted === true);
        break;
      }
      case "package-error": {
        if (supervisor !== null && !finished) {
          if (message.name !== resolvingPackage) {
            throw new Error(`unexpected package ${message.name}`);
          }
          supervisor.rejectPackage();
          resolvingPackage = null;
          pump();
        }
        break;
      }
      default:
        throw new Error(`unknown computer worker message ${message.type}`);
    }
  } catch (error) {
    fail(error);
  }
};
