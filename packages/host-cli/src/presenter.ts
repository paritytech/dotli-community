// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The terminal presentation layer. A host IS the UI layer: the web host
// answers the core with modals, this one answers with a QR and readline
// prompts. Everything is swappable behind `HostPresenter` so an embedding CLI
// can restyle without re-wiring callbacks (and tests can script decisions).

import * as readline from "node:readline/promises";
import type { AuthState } from "@parity/truapi-host";
import { shortHex } from "./hex.js";
import { renderQrTerminal } from "./qr.js";
import type { ConfirmRequest } from "./reviews.js";

export interface HostPresenter {
  /** Render the core-owned auth lifecycle (QR, progress, session identity). */
  authStateChanged(state: AuthState): void;
  /** Ask the user to approve a reviewed action or permission. */
  confirm(request: ConfirmRequest): Promise<boolean>;
  /** Show a product notification. */
  notify(text: string): void;
  /** Hand a URL to the user (the CLI cannot assume a system browser). */
  openUrl(url: string): void;
  dispose(): void;
}

export interface TerminalPresenterOptions {
  /** Where to render. Defaults to stderr so piped stdout stays clean. */
  output?: NodeJS.WriteStream;
  /** Where confirm prompts read from. Defaults to stdin. */
  input?: NodeJS.ReadStream;
  /** Override the QR renderer (tests, exotic terminals). */
  renderQr?: (deeplink: string) => Promise<string>;
}

export function createTerminalPresenter(
  options: TerminalPresenterOptions = {},
): HostPresenter {
  const output = options.output ?? process.stderr;
  const input = options.input ?? process.stdin;
  const renderQr = options.renderQr ?? renderQrTerminal;
  const write = (text: string): void => {
    output.write(text);
  };

  let progressTimer: NodeJS.Timeout | null = null;
  let disposed = false;
  // Confirm prompts share one stdin. Serialize them so two overlapping
  // reviews can never interleave their answers.
  let promptChain: Promise<void> = Promise.resolve();

  const clearProgress = (): void => {
    if (progressTimer !== null) {
      clearInterval(progressTimer);
      progressTimer = null;
      if (output.isTTY) {
        write("\n");
      }
    }
  };

  const startProgress = (label: string): void => {
    clearProgress();
    const startedAt = Date.now();
    if (!output.isTTY) {
      write(`${label}\n`);
      return;
    }
    write(label);
    progressTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      write(`\r${label} ${String(elapsed)}s`);
    }, 1000);
    // A progress line must never be the thing keeping the process alive.
    progressTimer.unref();
  };

  return {
    authStateChanged(state) {
      if (disposed) {
        return;
      }
      switch (state.tag) {
        case "Pairing": {
          const { deeplink } = state.value;
          void renderQr(deeplink).then(
            (qr) => {
              if (disposed) {
                return;
              }
              write(
                `\nScan with the Polkadot app to sign in:\n\n${qr}\n` +
                  `Or open this link on your phone:\n  ${deeplink}\n\n`,
              );
            },
            () => {
              // A QR that fails to render must not hide the deeplink.
              write(
                `\nOpen this link on your phone to sign in:\n  ${deeplink}\n\n`,
              );
            },
          );
          break;
        }
        case "Authenticating":
          // The People-chain statement round-trip runs ~20s with no further
          // callback. Without this line the host looks hung on a stale QR.
          startProgress(
            "Confirmed on your phone. Completing sign-in (about 20 seconds)…",
          );
          break;
        case "Connected": {
          clearProgress();
          const { publicKey, fullUsername, liteUsername } = state.value;
          const username = fullUsername ?? liteUsername;
          write(
            `Signed in${username !== undefined ? ` as ${username}` : ""} (${shortHex(publicKey)}).\n`,
          );
          break;
        }
        case "LoginFailed":
          clearProgress();
          write(`Sign-in failed: ${state.value.reason}\n`);
          break;
        case "Disconnected":
          clearProgress();
          write("Signed out.\n");
          break;
      }
    },

    confirm(request) {
      const decision = promptChain.then(async () => {
        if (disposed) {
          return false;
        }
        clearProgress();
        const lines = [
          "",
          `▸ ${request.title}`,
          ...request.details.map((detail) => `    ${detail}`),
        ];
        if (request.phoneVerifies) {
          lines.push(
            "    Verify the full details in the Polkadot app on your phone.",
            "    Nothing is signed until you approve it there.",
          );
        }
        write(`${lines.join("\n")}\n`);
        if (!input.isTTY) {
          // A host that cannot ask must not approve.
          write("  No interactive terminal, denying automatically.\n");
          return false;
        }
        const rl = readline.createInterface({ input, output });
        try {
          const answer = await rl.question("  Continue? [y/N] ");
          return /^y(es)?$/i.test(answer.trim());
        } finally {
          rl.close();
        }
      });
      promptChain = decision.then(
        () => {},
        () => {},
      );
      return decision;
    },

    notify(text) {
      write(`• ${text}\n`);
    },

    openUrl(url) {
      write(`Open this link in your browser:\n  ${url}\n`);
    },

    dispose() {
      disposed = true;
      clearProgress();
    },
  };
}
