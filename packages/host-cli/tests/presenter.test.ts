// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The prompt-routing contract. Inside embedded contexts (a git remote
// helper) the standard streams belong to someone else, so prompts must reach
// the controlling terminal instead, and a host that cannot ask must deny.

import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { createTerminalPresenter } from "../src/presenter.js";
import type { TtyStreams } from "../src/tty.js";

const REQUEST = {
  title: "Sign a message",
  details: ["account: test.dot (derivation #0)"],
  phoneVerifies: true,
};

/** A writable that records everything written to it. */
function sink() {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on("data", (chunk: Buffer) => chunks.push(String(chunk)));
  return {
    stream: stream as unknown as NodeJS.WriteStream,
    text: () => chunks.join(""),
  };
}

/** A fake controlling terminal whose keyboard we can type on. */
function fakeTty() {
  const keyboard = new PassThrough();
  const screen = sink();
  let closed = false;
  const streams: TtyStreams = {
    input: keyboard as unknown as NodeJS.ReadStream,
    output: screen.stream,
    close() {
      closed = true;
    },
  };
  return {
    streams,
    type: (text: string) => keyboard.write(text),
    screenText: screen.text,
    wasClosed: () => closed,
  };
}

describe("createTerminalPresenter prompt routing", () => {
  it("As a git remote helper, I prompt on the controlling terminal and the approval flows back", async () => {
    // Given
    const out = sink();
    const tty = fakeTty();
    const presenter = createTerminalPresenter({
      output: out.stream,
      input: "tty",
      openTty: () => tty.streams,
    });

    // When
    const decision = presenter.confirm(REQUEST);
    tty.type("y\n");

    // Then
    expect(await decision).toBe(true);
    // The prompt block renders on the presenter output (stderr in real use);
    // the question and answer go through the terminal.
    expect(out.text()).toContain("Sign a message");
    expect(tty.screenText()).toContain("Continue? [y/N]");
    expect(tty.wasClosed()).toBe(true);
    presenter.dispose();
  });

  it("As a git remote helper, a non-approval answer on the terminal denies", async () => {
    // Given
    const out = sink();
    const tty = fakeTty();
    const presenter = createTerminalPresenter({
      output: out.stream,
      input: "tty",
      openTty: () => tty.streams,
    });

    // When
    const decision = presenter.confirm(REQUEST);
    tty.type("\n");

    // Then
    expect(await decision).toBe(false);
    expect(tty.wasClosed()).toBe(true);
    presenter.dispose();
  });

  it("As a process with no controlling terminal, prompts deny automatically", async () => {
    // Given
    const out = sink();
    const presenter = createTerminalPresenter({
      output: out.stream,
      input: "tty",
      openTty: () => undefined,
    });

    // When
    const decision = await presenter.confirm(REQUEST);

    // Then
    expect(decision).toBe(false);
    expect(out.text()).toContain("No controlling terminal");
    presenter.dispose();
  });

  it("As a CI process with piped stdin, prompts deny automatically", async () => {
    // Given
    const out = sink();
    const pipedStdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const presenter = createTerminalPresenter({
      output: out.stream,
      input: pipedStdin,
    });

    // When
    const decision = await presenter.confirm(REQUEST);

    // Then
    expect(decision).toBe(false);
    expect(out.text()).toContain("No interactive terminal");
    presenter.dispose();
  });
});
