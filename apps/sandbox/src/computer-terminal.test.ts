// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  ComputerTerminal,
  DEFAULT_BACKGROUND,
  DEFAULT_FOREGROUND,
  keyEventToBytes,
  type TerminalCell,
} from "./computer-terminal";

const encoder = new TextEncoder();

const RED = 0xbf616a;
const GREEN = 0xa3be8c;
const YELLOW = 0xebcb8b;
const BRIGHT_GREEN = 0xb6d7a8;

function feed(terminal: ComputerTerminal, data: string): void {
  terminal.write(encoder.encode(data));
}

function cellAt(
  terminal: ComputerTerminal,
  row: number,
  column: number,
): TerminalCell {
  const snapshot = terminal.snapshot();
  return snapshot.cells[row * snapshot.columns + column];
}

describe("ComputerTerminal cursor addressing", () => {
  it("places characters via CUP and HVP", () => {
    const terminal = new ComputerTerminal(20, 5);
    feed(terminal, "\x1b[2;3HX\x1b[4;1fY");
    expect(cellAt(terminal, 1, 2).character).toBe("X");
    expect(cellAt(terminal, 3, 0).character).toBe("Y");
    expect(terminal.text()).toBe("\n  X\n\nY\n");
  });

  it("moves relatively with CUU/CUD/CUF/CUB and clamps at edges", () => {
    const terminal = new ComputerTerminal(10, 4);
    feed(terminal, "\x1b[2;2HA"); // cursor now row 1, column 2
    feed(terminal, "\x1b[B\x1b[2CB"); // down 1, right 2
    expect(cellAt(terminal, 2, 4).character).toBe("B");
    feed(terminal, "\x1b[9A\x1b[99DC"); // clamped to top-left
    expect(cellAt(terminal, 0, 0).character).toBe("C");
    const snapshot = terminal.snapshot();
    expect(snapshot.cursorRow).toBe(0);
    expect(snapshot.cursorColumn).toBe(1);
  });

  it("erases with EL modes without moving the cursor", () => {
    const terminal = new ComputerTerminal(10, 3);
    feed(terminal, "abcdef\x1b[1;4H\x1b[K");
    expect(terminal.text()).toBe("abc\n\n");
    feed(terminal, "\x1b[2;1Hzzzzzz\x1b[2;3H\x1b[1K");
    expect(terminal.text()).toBe("abc\n   zzz\n");
    feed(terminal, "\x1b[2K");
    expect(terminal.text()).toBe("abc\n\n");
  });

  it("erases with ED modes relative to the cursor", () => {
    const terminal = new ComputerTerminal(4, 3);
    feed(terminal, "aaaa\r\nbbbb\r\ncccc");
    feed(terminal, "\x1b[2;2H\x1b[J");
    expect(terminal.text()).toBe("aaaa\nb\n");
    feed(terminal, "\x1b[1;3Hxx\r\nyyyy\x1b[1;4H\x1b[1J");
    expect(terminal.text()).toBe("\nyyyy\n");
    feed(terminal, "\x1b[2J");
    expect(terminal.text()).toBe("\n\n");
  });
});

describe("ComputerTerminal graphics attributes", () => {
  it("applies ANSI colors, bold brightening, inverse, and reset", () => {
    const terminal = new ComputerTerminal(10, 2);
    feed(terminal, "\x1b[31mA\x1b[1;32mB\x1b[0m\x1b[7;33mC\x1b[mD");

    const a = cellAt(terminal, 0, 0);
    expect(a.foreground).toBe(RED);
    expect(a.background).toBe(DEFAULT_BACKGROUND);
    expect(a.bold).toBe(false);
    expect(a.inverse).toBe(false);

    const b = cellAt(terminal, 0, 1);
    expect(b.foreground).toBe(BRIGHT_GREEN); // bold maps normal -> bright
    expect(b.bold).toBe(true);

    const c = cellAt(terminal, 0, 2);
    expect(c.foreground).toBe(YELLOW);
    expect(c.background).toBe(DEFAULT_BACKGROUND);
    expect(c.inverse).toBe(true);

    const d = cellAt(terminal, 0, 3);
    expect(d.foreground).toBe(DEFAULT_FOREGROUND);
    expect(d.background).toBe(DEFAULT_BACKGROUND);
    expect(d.bold).toBe(false);
    expect(d.inverse).toBe(false);
  });

  it("applies background colors and SGR 39/49 defaults", () => {
    const terminal = new ComputerTerminal(10, 2);
    feed(terminal, "\x1b[42;31mA\x1b[39;49mB");
    const a = cellAt(terminal, 0, 0);
    expect(a.background).toBe(GREEN);
    expect(a.foreground).toBe(RED);
    const b = cellAt(terminal, 0, 1);
    expect(b.background).toBe(DEFAULT_BACKGROUND);
    expect(b.foreground).toBe(DEFAULT_FOREGROUND);
  });

  it("handles extended 256-color SGR without corrupting later parameters", () => {
    const terminal = new ComputerTerminal(10, 2);
    feed(terminal, "\x1b[38;5;196mX");
    expect(cellAt(terminal, 0, 0).foreground).toBe(0xff0000);
    expect(cellAt(terminal, 0, 0).bold).toBe(false);
    feed(terminal, "\x1b[0m\x1b[48;2;1;2;3mY");
    expect(cellAt(terminal, 0, 1).background).toBe(0x010203);
  });
});

describe("ComputerTerminal scrolling", () => {
  it("scrolls only inside a DECSTBM region on line feed at its bottom", () => {
    const terminal = new ComputerTerminal(10, 5);
    feed(terminal, "top\x1b[2;1HA\x1b[3;1HB\x1b[4;1HC\x1b[5;1Hbot");
    feed(terminal, "\x1b[2;4r"); // rows 2..4 (1-based) scroll
    const homed = terminal.snapshot();
    expect(homed.cursorRow).toBe(0); // DECSTBM homes the cursor
    expect(homed.cursorColumn).toBe(0);
    feed(terminal, "\x1b[4;1H\n");
    expect(terminal.text()).toBe("top\nB\nC\n\nbot");
  });

  it("scrolls down on reverse index at the region top", () => {
    const terminal = new ComputerTerminal(10, 5);
    feed(terminal, "top\x1b[2;1HA\x1b[3;1HB\x1b[4;1HC\x1b[5;1Hbot");
    feed(terminal, "\x1b[2;4r\x1b[2;1H\x1bM");
    expect(terminal.text()).toBe("top\n\nA\nB\nbot");
  });

  it("scrolls the whole screen when writing past the last row", () => {
    const terminal = new ComputerTerminal(10, 3);
    feed(terminal, "one\r\ntwo\r\nthree\r\nfour");
    expect(terminal.text()).toBe("two\nthree\nfour");
  });

  it("inserts and deletes lines within the region", () => {
    const terminal = new ComputerTerminal(10, 4);
    feed(terminal, "a\r\nb\r\nc\r\nd");
    feed(terminal, "\x1b[2;1H\x1b[L"); // insert blank line at row 2
    expect(terminal.text()).toBe("a\n\nb\nc");
    feed(terminal, "\x1b[2;1H\x1b[M"); // delete it again
    expect(terminal.text()).toBe("a\nb\nc\n");
  });
});

describe("ComputerTerminal wrapping and resize", () => {
  it("wraps at the last column", () => {
    const terminal = new ComputerTerminal(10, 3);
    feed(terminal, "0123456789AB");
    expect(terminal.text()).toBe("0123456789\nAB\n");
    const snapshot = terminal.snapshot();
    expect(snapshot.cursorRow).toBe(1);
    expect(snapshot.cursorColumn).toBe(2);
  });

  it("defers the wrap until the next printable character", () => {
    const terminal = new ComputerTerminal(10, 3);
    feed(terminal, "0123456789");
    expect(terminal.snapshot().cursorColumn).toBe(9);
    feed(terminal, "\rZ");
    expect(terminal.text()).toBe("Z123456789\n\n");
  });

  it("preserves top-left content across resize", () => {
    const terminal = new ComputerTerminal(10, 3);
    feed(terminal, "hello\r\nworld");
    terminal.resize(20, 5);
    expect(terminal.text()).toBe("hello\nworld\n\n\n");
    terminal.resize(4, 2);
    expect(terminal.text()).toBe("hell\nworl");
    const snapshot = terminal.snapshot();
    expect(snapshot.columns).toBe(4);
    expect(snapshot.rows).toBe(2);
    expect(snapshot.cursorColumn).toBeLessThan(4);
    expect(snapshot.cursorRow).toBeLessThan(2);
  });
});

describe("ComputerTerminal vim-like output", () => {
  it("renders a realistic vim screen draw", () => {
    const terminal = new ComputerTerminal(20, 5);
    feed(
      terminal,
      "\x1b]0;ignored window title\x07" + // OSC skipped
        "\x1b[?1049h\x1b[?2004h" + // alt screen + unknown private mode
        "\x1b[?25l\x1b[2J\x1b[H" +
        "hello world\r\n" +
        "~\r\n~\r\n~\r\n" +
        "\x1b[5;1H\x1b[7m-- INSERT --\x1b[m" +
        "\x1b[1;12H\x1b[?25h",
    );
    expect(terminal.text()).toBe("hello world\n~\n~\n~\n-- INSERT --");
    const snapshot = terminal.snapshot();
    expect(snapshot.cursorVisible).toBe(true);
    expect(snapshot.cursorRow).toBe(0);
    expect(snapshot.cursorColumn).toBe(11);
    expect(cellAt(terminal, 4, 0).inverse).toBe(true);
    expect(cellAt(terminal, 0, 0).inverse).toBe(false);
  });

  it("toggles cursor visibility via DECTCEM", () => {
    const terminal = new ComputerTerminal(10, 2);
    feed(terminal, "\x1b[?25l");
    expect(terminal.snapshot().cursorVisible).toBe(false);
    feed(terminal, "\x1b[?25h");
    expect(terminal.snapshot().cursorVisible).toBe(true);
  });

  it("treats leaving the alternate screen as clear + cursor restore", () => {
    const terminal = new ComputerTerminal(10, 3);
    feed(terminal, "\x1b[2;3H\x1b[?1049halt screen\x1b[?1049l");
    expect(terminal.text()).toBe("\n\n");
    const snapshot = terminal.snapshot();
    expect(snapshot.cursorRow).toBe(1);
    expect(snapshot.cursorColumn).toBe(2);
  });

  it("skips unknown CSI, ST-terminated OSC, and stray bytes safely", () => {
    const terminal = new ComputerTerminal(10, 2);
    feed(
      terminal,
      "\x1b[>c\x1b]2;title\x1b\\\x1b[12;34;56z\x1b[?1002h\x1b[4h\x00\x05ok",
    );
    expect(terminal.text()).toBe("ok\n");
  });

  it("decodes multi-byte UTF-8 printables", () => {
    const terminal = new ComputerTerminal(10, 2);
    terminal.write(Uint8Array.from([0xc3, 0xa9, 0xe2, 0x82, 0xac]));
    expect(terminal.text()).toBe("é€\n");
  });

  it.each([
    [
      "lead byte above F4",
      [0xf5, 0x80, 0x80, 0x80],
      "\ufffd\ufffd\ufffd\ufffd",
    ],
    [
      "code point above U+10FFFF",
      [0xf4, 0x90, 0x80, 0x80],
      "\ufffd\ufffd\ufffd\ufffd",
    ],
    ["overlong two-byte sequence", [0xc0, 0xaf], "\ufffd\ufffd"],
    ["overlong three-byte sequence", [0xe0, 0x80, 0x80], "\ufffd\ufffd\ufffd"],
    ["UTF-16 surrogate", [0xed, 0xa0, 0x80], "\ufffd\ufffd\ufffd"],
    ["bad continuation", [0xe2, 0x28, 0xa1], "\ufffd(\ufffd"],
  ])("replaces a malformed UTF-8 %s", (_name, bytes, replacement) => {
    const terminal = new ComputerTerminal(20, 2);
    terminal.write(Uint8Array.from([...bytes, 0x41]));
    expect(terminal.text()).toBe(`${replacement}A\n`);
  });

  it("streams the highest valid Unicode code point across writes", () => {
    const terminal = new ComputerTerminal(10, 2);
    terminal.write(Uint8Array.from([0xf4, 0x8f]));
    terminal.write(Uint8Array.from([0xbf, 0xbf]));
    expect(terminal.text()).toBe("\u{10ffff}\n");
  });
});

describe("keyEventToBytes", () => {
  interface KeyEvent {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }
  const key = (
    keyName: string,
    modifiers: Partial<Omit<KeyEvent, "key">> = {},
  ): KeyEvent => ({
    key: keyName,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  });

  it("passes printable characters through as UTF-8", () => {
    expect(keyEventToBytes(key("a"))).toEqual(Uint8Array.from([0x61]));
    expect(keyEventToBytes(key("A", { shiftKey: true }))).toEqual(
      Uint8Array.from([0x41]),
    );
    expect(keyEventToBytes(key(" "))).toEqual(Uint8Array.from([0x20]));
    expect(keyEventToBytes(key("é"))).toEqual(Uint8Array.from([0xc3, 0xa9]));
    expect(keyEventToBytes(key("€"))).toEqual(
      Uint8Array.from([0xe2, 0x82, 0xac]),
    );
  });

  it("maps control chords", () => {
    expect(keyEventToBytes(key("c", { ctrlKey: true }))).toEqual(
      Uint8Array.from([0x03]),
    );
    expect(keyEventToBytes(key("z", { ctrlKey: true }))).toEqual(
      Uint8Array.from([0x1a]),
    );
    expect(
      keyEventToBytes(key("A", { ctrlKey: true, shiftKey: true })),
    ).toEqual(Uint8Array.from([0x01]));
    expect(keyEventToBytes(key("[", { ctrlKey: true }))).toEqual(
      Uint8Array.from([0x1b]),
    );
    expect(keyEventToBytes(key("\\", { ctrlKey: true }))).toEqual(
      Uint8Array.from([0x1c]),
    );
    expect(keyEventToBytes(key("]", { ctrlKey: true }))).toEqual(
      Uint8Array.from([0x1d]),
    );
    expect(
      keyEventToBytes(key("^", { ctrlKey: true, shiftKey: true })),
    ).toEqual(Uint8Array.from([0x1e]));
    expect(
      keyEventToBytes(key("_", { ctrlKey: true, shiftKey: true })),
    ).toEqual(Uint8Array.from([0x1f]));
    expect(keyEventToBytes(key(" ", { ctrlKey: true }))).toEqual(
      Uint8Array.from([0x00]),
    );
    expect(keyEventToBytes(key("1", { ctrlKey: true }))).toBeNull();
  });

  it("maps editing and navigation keys to TTY sequences", () => {
    expect(keyEventToBytes(key("Enter"))).toEqual(Uint8Array.from([0x0d]));
    expect(keyEventToBytes(key("Backspace"))).toEqual(Uint8Array.from([0x7f]));
    expect(keyEventToBytes(key("Tab"))).toEqual(Uint8Array.from([0x09]));
    expect(keyEventToBytes(key("Escape"))).toEqual(Uint8Array.from([0x1b]));
    const csi = (...tail: number[]): Uint8Array =>
      Uint8Array.from([0x1b, 0x5b, ...tail]);
    expect(keyEventToBytes(key("ArrowUp"))).toEqual(csi(0x41));
    expect(keyEventToBytes(key("ArrowDown"))).toEqual(csi(0x42));
    expect(keyEventToBytes(key("ArrowRight"))).toEqual(csi(0x43));
    expect(keyEventToBytes(key("ArrowLeft"))).toEqual(csi(0x44));
    expect(keyEventToBytes(key("Home"))).toEqual(csi(0x48));
    expect(keyEventToBytes(key("End"))).toEqual(csi(0x46));
    expect(keyEventToBytes(key("Insert"))).toEqual(csi(0x32, 0x7e));
    expect(keyEventToBytes(key("Delete"))).toEqual(csi(0x33, 0x7e));
    expect(keyEventToBytes(key("PageUp"))).toEqual(csi(0x35, 0x7e));
    expect(keyEventToBytes(key("PageDown"))).toEqual(csi(0x36, 0x7e));
  });

  it("prefixes ESC for Alt chords", () => {
    expect(keyEventToBytes(key("x", { altKey: true }))).toEqual(
      Uint8Array.from([0x1b, 0x78]),
    );
    expect(keyEventToBytes(key("b", { altKey: true, ctrlKey: true }))).toEqual(
      Uint8Array.from([0x1b, 0x02]),
    );
    expect(keyEventToBytes(key("ArrowUp", { altKey: true }))).toEqual(
      Uint8Array.from([0x1b, 0x1b, 0x5b, 0x41]),
    );
  });

  it("returns null for modifier-only and unhandled keys", () => {
    expect(keyEventToBytes(key("Shift", { shiftKey: true }))).toBeNull();
    expect(keyEventToBytes(key("Control", { ctrlKey: true }))).toBeNull();
    expect(keyEventToBytes(key("Alt", { altKey: true }))).toBeNull();
    expect(keyEventToBytes(key("Meta"))).toBeNull();
    expect(keyEventToBytes(key("CapsLock"))).toBeNull();
    expect(keyEventToBytes(key("F5"))).toBeNull();
    expect(keyEventToBytes(key("Dead"))).toBeNull();
  });
});
