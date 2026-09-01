// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;
// Pairing deeplinks carry the handshake secret. Scrub them from logs.
const PAIRING_DEEPLINK = /polkadotapp:\/\/pair\?[^\s'"]+/g;

export interface SigningHostConfig {
  binary: string;
  basePath: string;
  network: string;
  productId: string;
  liteUsernamePrefix?: string;
}

export interface SigningHostExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export interface SigningHostProcess {
  child: ChildProcess;
  completed: Promise<SigningHostExit>;
  output: () => string;
}

// Preflight so a missing binary fails with install guidance instead of a
// spawn ENOENT buried in the pair retry loop.
export function signingHostVersion(binary: string): string | null {
  const probe = spawnSync(binary, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return null;
  return probe.stdout.trim();
}

export function sanitizeSigningHostOutput(text: string): string {
  return text.replace(PAIRING_DEEPLINK, "<pairing deeplink>");
}

// Spawns `truapi-host signing-host … exec "/pair <deeplink>"`: answers the
// handshake, then keeps auto-signing SignRequests until SIGTERMed.
export function startSigningHostPair(
  config: SigningHostConfig,
  deeplink: string,
): SigningHostProcess {
  const args = [
    "signing-host",
    "--network",
    config.network,
    "--base-path",
    config.basePath,
    "--product-id",
    config.productId,
    "--auto-accept",
  ];
  if (config.liteUsernamePrefix !== undefined) {
    args.push("--lite-username-prefix", config.liteUsernamePrefix);
  }
  args.push("exec", `/pair ${deeplink}`);

  const child = spawn(config.binary, args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let captured = "";
  const append = (line: string): void => {
    captured = `${captured}${line}\n`;
    if (Buffer.byteLength(captured) > MAX_CAPTURED_OUTPUT_BYTES) {
      captured = captured.slice(-MAX_CAPTURED_OUTPUT_BYTES);
    }
  };
  pipeLines(child.stdout, process.stdout, "[signing-host]", append);
  pipeLines(child.stderr, process.stderr, "[signing-host]", append);

  const completed = new Promise<SigningHostExit>((resolve) => {
    child.once("error", (error) => {
      resolve({ code: null, signal: null, error: error.message });
    });
    // "close", not "exit": stdio has flushed, so output() holds the final
    // stderr lines that usually explain the failure.
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });

  return {
    child,
    completed,
    output: () => captured.trimEnd(),
  };
}

export async function stopSigningHost(proc: SigningHostProcess): Promise<void> {
  if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
    return;
  }
  proc.child.kill("SIGTERM");
  const stopped = await Promise.race([
    proc.completed.then(() => true),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      timer.unref();
    }),
  ]);
  if (!stopped && proc.child.exitCode === null) {
    proc.child.kill("SIGKILL");
    await proc.completed;
  }
}

// Pid-based stop for crash recovery, where no ChildProcess handle survived.
// SIGTERM, wait up to 5s for the exit, then SIGKILL.
export async function stopSigningHostPid(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Exited between the last check and now.
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function formatSigningHostExit(
  result: SigningHostExit,
  output: string,
): string {
  const status =
    result.error ??
    (result.code !== null
      ? `exit code ${result.code}`
      : `signal ${result.signal ?? "unknown"}`);
  const detail = sanitizeSigningHostOutput(output).trim();
  return detail.length > 0
    ? `signing-host stopped before login (${status}):\n${detail}`
    : `signing-host stopped before login (${status})`;
}

function pipeLines(
  stream: Readable | null,
  destination: Writable,
  prefix: string,
  append: (line: string) => void,
): void {
  if (stream === null) {
    return;
  }
  stream.setEncoding("utf8");
  let buffered = "";
  const emit = (line: string): void => {
    const sanitized = sanitizeSigningHostOutput(line);
    append(sanitized);
    destination.write(`${prefix} ${sanitized}\n`);
  };
  stream.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) {
        emit(line);
      }
    }
  });
  stream.on("end", () => {
    if (buffered.length > 0) {
      emit(buffered);
    }
  });
}
