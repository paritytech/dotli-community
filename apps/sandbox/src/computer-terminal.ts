// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// VT emulator and keyboard translation for the experimental polkavm-computer
// app kind. Ported from the Rust reference implementation in
// pvm-terminal (vt.rs, input.rs, render.rs); escape-sequence semantics follow
// that emulator with the additions vim (feature-tiny, TERM=xterm) relies on:
// DECSTBM scroll regions, reverse index, insert/delete line and character,
// alternate screen (?1049, treated as clear + cursor save/restore), and safe
// skipping of OSC/DCS and unknown CSI sequences.

const ESCAPE = 0x1b;

// Palette from render.rs / vt.rs, with the alpha channel dropped (0xRRGGBB).
export const DEFAULT_FOREGROUND = 0xd8dee9;
export const DEFAULT_BACKGROUND = 0x181b20;
const ANSI_NORMAL: readonly number[] = [
  0x2e3440, 0xbf616a, 0xa3be8c, 0xebcb8b, 0x5e81ac, 0xb48ead, 0x88c0d0,
  0xe5e9f0,
];
const ANSI_BRIGHT: readonly number[] = [
  0x4c566a, 0xd08770, 0xb6d7a8, 0xffd787, 0x81a1c1, 0xcaa9d8, 0x8fd7e8,
  0xffffff,
];

export interface TerminalCell {
  character: string;
  /** 0xRRGGBB, already brightened when written bold; not swapped for inverse. */
  foreground: number;
  /** 0xRRGGBB; renderers swap foreground/background when `inverse` is set. */
  background: number;
  inverse: boolean;
  bold: boolean;
}

export interface TerminalSnapshot {
  cells: TerminalCell[];
  columns: number;
  rows: number;
  cursorRow: number;
  cursorColumn: number;
  cursorVisible: boolean;
}

// Plain const object: `erasableSyntaxOnly` forbids TypeScript enums.
const ParseState = {
  Ground: 0,
  Escape: 1,
  Csi: 2,
  /** OSC / DCS / PM / APC string: consumed until BEL or ST. */
  StringSequence: 3,
  /** Saw ESC inside a string sequence; a following `\` terminates it. */
  StringEscape: 4,
} as const;
type ParseState = (typeof ParseState)[keyof typeof ParseState];

const MAX_PARAMETERS = 8;
const MAX_PARAMETER_VALUE = 9_999;

function blankCell(foreground: number, background: number): TerminalCell {
  return {
    character: " ",
    foreground,
    background,
    inverse: false,
    bold: false,
  };
}

function brighten(color: number): number {
  const index = ANSI_NORMAL.indexOf(color);
  return index === -1 ? color : ANSI_BRIGHT[index];
}

export class ComputerTerminal {
  private cells: TerminalCell[];
  private columns: number;
  private rows: number;
  private column = 0;
  private row = 0;
  private savedColumn = 0;
  private savedRow = 0;
  private altSavedColumn = 0;
  private altSavedRow = 0;
  private scrollTop = 0;
  private scrollBottom: number;
  private foreground = DEFAULT_FOREGROUND;
  private background = DEFAULT_BACKGROUND;
  private bold = false;
  private inverse = false;
  private cursorVisible = true;
  private state: ParseState = ParseState.Ground;
  private readonly parameters = new Uint16Array(MAX_PARAMETERS);
  private parameterIndex = 0;
  private parameterPresent = false;
  private privateMode = false;
  private csiIgnored = false;
  // Streaming UTF-8 decode state for ground bytes.
  private utf8Pending = 0;
  private utf8CodePoint = 0;

  constructor(columns: number, rows: number) {
    this.columns = Math.max(1, columns);
    this.rows = Math.max(1, rows);
    this.scrollBottom = this.rows - 1;
    this.cells = this.blankGrid();
  }

  write(bytes: Uint8Array): void {
    for (const byte of bytes) {
      this.writeByte(byte);
    }
  }

  resize(columns: number, rows: number): void {
    const nextColumns = Math.max(1, columns);
    const nextRows = Math.max(1, rows);
    if (nextColumns === this.columns && nextRows === this.rows) {
      return;
    }
    const next: TerminalCell[] = new Array<TerminalCell>(
      nextColumns * nextRows,
    );
    for (let row = 0; row < nextRows; row += 1) {
      for (let column = 0; column < nextColumns; column += 1) {
        next[row * nextColumns + column] =
          row < this.rows && column < this.columns
            ? this.cells[row * this.columns + column]
            : blankCell(this.foreground, this.background);
      }
    }
    this.cells = next;
    this.columns = nextColumns;
    this.rows = nextRows;
    this.scrollTop = 0;
    this.scrollBottom = nextRows - 1;
    this.column = Math.min(this.column, nextColumns - 1);
    this.row = Math.min(this.row, nextRows - 1);
    this.savedColumn = Math.min(this.savedColumn, nextColumns - 1);
    this.savedRow = Math.min(this.savedRow, nextRows - 1);
  }

  snapshot(): TerminalSnapshot {
    return {
      cells: this.cells.map((cell) => ({ ...cell })),
      columns: this.columns,
      rows: this.rows,
      cursorRow: this.row,
      cursorColumn: Math.min(this.column, this.columns - 1),
      cursorVisible: this.cursorVisible,
    };
  }

  text(): string {
    const lines: string[] = [];
    for (let row = 0; row < this.rows; row += 1) {
      let line = "";
      for (let column = 0; column < this.columns; column += 1) {
        line += this.cells[row * this.columns + column].character;
      }
      lines.push(line.replace(/ +$/, ""));
    }
    return lines.join("\n");
  }

  private blankGrid(): TerminalCell[] {
    const cells: TerminalCell[] = new Array<TerminalCell>(
      this.columns * this.rows,
    );
    for (let index = 0; index < cells.length; index += 1) {
      cells[index] = blankCell(this.foreground, this.background);
    }
    return cells;
  }

  private writeByte(byte: number): void {
    switch (this.state) {
      case ParseState.Ground:
        this.writeGround(byte);
        break;
      case ParseState.Escape:
        this.writeEscape(byte);
        break;
      case ParseState.Csi:
        this.writeCsi(byte);
        break;
      case ParseState.StringSequence:
        if (byte === 0x07) {
          this.state = ParseState.Ground;
        } else if (byte === ESCAPE) {
          this.state = ParseState.StringEscape;
        }
        break;
      case ParseState.StringEscape:
        this.state =
          byte === 0x5c ? ParseState.Ground : ParseState.StringSequence;
        break;
    }
  }

  private writeGround(byte: number): void {
    if (this.utf8Pending > 0) {
      if ((byte & 0xc0) === 0x80) {
        this.utf8CodePoint = (this.utf8CodePoint << 6) | (byte & 0x3f);
        this.utf8Pending -= 1;
        if (this.utf8Pending === 0) {
          this.put(String.fromCodePoint(this.utf8CodePoint));
        }
        return;
      }
      // Malformed sequence: drop it and reinterpret the current byte.
      this.utf8Pending = 0;
    }
    switch (byte) {
      case ESCAPE:
        this.state = ParseState.Escape;
        return;
      case 0x0a:
        this.lineFeed();
        return;
      case 0x0d:
        this.column = 0;
        return;
      case 0x08:
        this.column = Math.max(0, Math.min(this.column, this.columns - 1) - 1);
        return;
      case 0x09:
        this.column = Math.min(
          (Math.floor(this.column / 8) + 1) * 8,
          this.columns - 1,
        );
        return;
      default:
        break;
    }
    if (byte >= 0x20 && byte <= 0x7e) {
      this.put(String.fromCharCode(byte));
    } else if ((byte & 0xe0) === 0xc0) {
      this.utf8Pending = 1;
      this.utf8CodePoint = byte & 0x1f;
    } else if ((byte & 0xf0) === 0xe0) {
      this.utf8Pending = 2;
      this.utf8CodePoint = byte & 0x0f;
    } else if ((byte & 0xf8) === 0xf0) {
      this.utf8Pending = 3;
      this.utf8CodePoint = byte & 0x07;
    }
    // Remaining C0/C1 bytes are ignored.
  }

  private writeEscape(byte: number): void {
    switch (byte) {
      case 0x5b: // [
        this.parameters.fill(0);
        this.parameterIndex = 0;
        this.parameterPresent = false;
        this.privateMode = false;
        this.csiIgnored = false;
        this.state = ParseState.Csi;
        return;
      case 0x5d: // ] OSC
      case 0x50: // P DCS
      case 0x5e: // ^ PM
      case 0x5f: // _ APC
        this.state = ParseState.StringSequence;
        return;
      case 0x37: // 7 DECSC
        this.savedColumn = this.column;
        this.savedRow = this.row;
        break;
      case 0x38: // 8 DECRC
        this.column = Math.min(this.savedColumn, this.columns - 1);
        this.row = Math.min(this.savedRow, this.rows - 1);
        break;
      case 0x4d: // M RI
        this.reverseIndex();
        break;
      case 0x44: // D IND
        this.lineFeed();
        break;
      case 0x63: // c RIS
        this.reset();
        break;
      default:
        break;
    }
    this.state = ParseState.Ground;
  }

  private writeCsi(byte: number): void {
    if (byte >= 0x30 && byte <= 0x39) {
      this.parameterPresent = true;
      const value = this.parameters[this.parameterIndex];
      this.parameters[this.parameterIndex] = Math.min(
        value * 10 + (byte - 0x30),
        MAX_PARAMETER_VALUE,
      );
      return;
    }
    if (byte === 0x3b) {
      if (this.parameterIndex + 1 < MAX_PARAMETERS) {
        this.parameterIndex += 1;
        this.parameterPresent = false;
      }
      return;
    }
    if (byte === 0x3f && this.parameterIndex === 0 && !this.parameterPresent) {
      this.privateMode = true;
      return;
    }
    if (byte >= 0x20 && byte <= 0x3f) {
      // Intermediates and other private markers: consume, ignore sequence.
      this.csiIgnored = true;
      return;
    }
    if (byte >= 0x40 && byte <= 0x7e) {
      if (!this.csiIgnored) {
        this.executeCsi(byte);
      }
      this.state = ParseState.Ground;
      return;
    }
    this.state = ParseState.Ground;
  }

  private executeCsi(command: number): void {
    switch (String.fromCharCode(command)) {
      case "A":
        this.row = Math.max(0, this.row - this.parameterOr(0, 1));
        break;
      case "B":
        this.row = Math.min(this.row + this.parameterOr(0, 1), this.rows - 1);
        break;
      case "C":
        this.column = Math.min(
          this.column + this.parameterOr(0, 1),
          this.columns - 1,
        );
        break;
      case "D":
        this.column = Math.max(0, this.column - this.parameterOr(0, 1));
        break;
      case "G":
        this.column = Math.min(this.parameterOr(0, 1) - 1, this.columns - 1);
        break;
      case "d":
        this.row = Math.min(this.parameterOr(0, 1) - 1, this.rows - 1);
        break;
      case "H":
      case "f":
        this.row = Math.min(this.parameterOr(0, 1) - 1, this.rows - 1);
        this.column = Math.min(this.parameterOr(1, 1) - 1, this.columns - 1);
        break;
      case "J":
        this.eraseDisplay(this.parameterOr(0, 0));
        break;
      case "K":
        this.eraseLine(this.parameterOr(0, 0));
        break;
      case "m":
        this.setGraphics();
        break;
      case "h":
        if (this.privateMode) {
          this.setPrivateModes(true);
        }
        break;
      case "l":
        if (this.privateMode) {
          this.setPrivateModes(false);
        }
        break;
      case "r":
        this.setScrollRegion();
        break;
      case "S":
        this.scrollUp(this.parameterOr(0, 1));
        break;
      case "T":
        this.scrollDown(this.parameterOr(0, 1));
        break;
      case "L":
        this.insertLines(this.parameterOr(0, 1));
        break;
      case "M":
        this.deleteLines(this.parameterOr(0, 1));
        break;
      case "@":
        this.insertCharacters(this.parameterOr(0, 1));
        break;
      case "P":
        this.deleteCharacters(this.parameterOr(0, 1));
        break;
      case "X":
        this.eraseCharacters(this.parameterOr(0, 1));
        break;
      case "s":
        this.savedColumn = this.column;
        this.savedRow = this.row;
        break;
      case "u":
        this.column = Math.min(this.savedColumn, this.columns - 1);
        this.row = Math.min(this.savedRow, this.rows - 1);
        break;
      default:
        break;
    }
  }

  private parameterCount(): number {
    return this.parameterPresent || this.parameterIndex > 0
      ? this.parameterIndex + 1
      : 1;
  }

  private parameterOr(index: number, fallback: number): number {
    const value = index < MAX_PARAMETERS ? this.parameters[index] : 0;
    return value === 0 ? fallback : value;
  }

  private setPrivateModes(enabled: boolean): void {
    for (let index = 0; index < this.parameterCount(); index += 1) {
      switch (this.parameters[index]) {
        case 25: // DECTCEM
          this.cursorVisible = enabled;
          break;
        case 1049:
          // No separate alternate screen buffer: entering saves the cursor
          // and clears; leaving clears and restores the cursor.
          if (enabled) {
            this.altSavedColumn = this.column;
            this.altSavedRow = this.row;
            this.eraseDisplay(2);
          } else {
            this.eraseDisplay(2);
            this.column = Math.min(this.altSavedColumn, this.columns - 1);
            this.row = Math.min(this.altSavedRow, this.rows - 1);
          }
          break;
        default:
          break;
      }
    }
  }

  private setScrollRegion(): void {
    const top = this.parameterOr(0, 1) - 1;
    const bottom = this.parameterOr(1, this.rows) - 1;
    if (top < bottom && bottom < this.rows) {
      this.scrollTop = top;
      this.scrollBottom = bottom;
    } else {
      this.scrollTop = 0;
      this.scrollBottom = this.rows - 1;
    }
    this.row = 0;
    this.column = 0;
  }

  private setGraphics(): void {
    const count = this.parameterCount();
    for (let index = 0; index < count; index += 1) {
      const parameter = this.parameters[index];
      if (parameter === 0) {
        this.resetAttributes();
      } else if (parameter === 1) {
        this.bold = true;
      } else if (parameter === 7) {
        this.inverse = true;
      } else if (parameter === 22) {
        this.bold = false;
      } else if (parameter === 27) {
        this.inverse = false;
      } else if (parameter >= 30 && parameter <= 37) {
        this.foreground = ANSI_NORMAL[parameter - 30];
      } else if (parameter === 39) {
        this.foreground = DEFAULT_FOREGROUND;
      } else if (parameter >= 40 && parameter <= 47) {
        this.background = ANSI_NORMAL[parameter - 40];
      } else if (parameter === 49) {
        this.background = DEFAULT_BACKGROUND;
      } else if (parameter >= 90 && parameter <= 97) {
        this.foreground = ANSI_BRIGHT[parameter - 90];
      } else if (parameter >= 100 && parameter <= 107) {
        this.background = ANSI_BRIGHT[parameter - 100];
      } else if (parameter === 38 || parameter === 48) {
        // Extended color: consume the sub-parameters so they are not
        // misread as free-standing SGR codes.
        const mode = index + 1 < count ? this.parameters[index + 1] : 0;
        if (mode === 5 && index + 2 < count) {
          const color = indexedColor(this.parameters[index + 2]);
          if (parameter === 38) {
            this.foreground = color;
          } else {
            this.background = color;
          }
          index += 2;
        } else if (mode === 2 && index + 4 < count) {
          const color =
            ((Math.min(this.parameters[index + 2], 255) << 16) |
              (Math.min(this.parameters[index + 3], 255) << 8) |
              Math.min(this.parameters[index + 4], 255)) >>>
            0;
          if (parameter === 38) {
            this.foreground = color;
          } else {
            this.background = color;
          }
          index += 4;
        } else {
          break;
        }
      }
    }
  }

  private put(character: string): void {
    if (this.column >= this.columns) {
      this.lineFeed();
      this.column = 0;
    }
    this.cells[this.row * this.columns + this.column] = {
      character,
      foreground: this.bold ? brighten(this.foreground) : this.foreground,
      background: this.background,
      inverse: this.inverse,
      bold: this.bold,
    };
    this.column += 1;
  }

  private lineFeed(): void {
    if (this.row === this.scrollBottom) {
      this.scrollUp(1);
      return;
    }
    if (this.row + 1 < this.rows) {
      this.row += 1;
    }
  }

  private reverseIndex(): void {
    if (this.row === this.scrollTop) {
      this.scrollDown(1);
      return;
    }
    if (this.row > 0) {
      this.row -= 1;
    }
  }

  private scrollUp(count: number): void {
    this.shiftRegion(this.scrollTop, this.scrollBottom, count);
  }

  private scrollDown(count: number): void {
    this.shiftRegion(this.scrollTop, this.scrollBottom, -count);
  }

  private insertLines(count: number): void {
    if (this.row < this.scrollTop || this.row > this.scrollBottom) {
      return;
    }
    this.shiftRegion(this.row, this.scrollBottom, -count);
  }

  private deleteLines(count: number): void {
    if (this.row < this.scrollTop || this.row > this.scrollBottom) {
      return;
    }
    this.shiftRegion(this.row, this.scrollBottom, count);
  }

  /** Shifts rows [top, bottom] up (`count` > 0) or down (`count` < 0). */
  private shiftRegion(top: number, bottom: number, count: number): void {
    const height = bottom - top + 1;
    const distance = Math.min(Math.abs(count), height);
    if (distance === 0) {
      return;
    }
    if (count > 0) {
      for (let row = top; row <= bottom - distance; row += 1) {
        this.copyRow(row + distance, row);
      }
      for (let row = bottom - distance + 1; row <= bottom; row += 1) {
        this.blankRow(row);
      }
    } else {
      for (let row = bottom; row >= top + distance; row -= 1) {
        this.copyRow(row - distance, row);
      }
      for (let row = top; row < top + distance; row += 1) {
        this.blankRow(row);
      }
    }
  }

  private copyRow(from: number, to: number): void {
    const source = from * this.columns;
    const target = to * this.columns;
    for (let column = 0; column < this.columns; column += 1) {
      this.cells[target + column] = this.cells[source + column];
    }
  }

  private blankRow(row: number): void {
    const start = row * this.columns;
    for (let column = 0; column < this.columns; column += 1) {
      this.cells[start + column] = blankCell(this.foreground, this.background);
    }
  }

  private insertCharacters(count: number): void {
    const start = this.row * this.columns;
    const column = Math.min(this.column, this.columns - 1);
    const distance = Math.min(count, this.columns - column);
    for (
      let target = this.columns - 1;
      target >= column + distance;
      target -= 1
    ) {
      this.cells[start + target] = this.cells[start + target - distance];
    }
    for (let target = column; target < column + distance; target += 1) {
      this.cells[start + target] = blankCell(this.foreground, this.background);
    }
  }

  private deleteCharacters(count: number): void {
    const start = this.row * this.columns;
    const column = Math.min(this.column, this.columns - 1);
    const distance = Math.min(count, this.columns - column);
    for (let target = column; target < this.columns - distance; target += 1) {
      this.cells[start + target] = this.cells[start + target + distance];
    }
    for (
      let target = this.columns - distance;
      target < this.columns;
      target += 1
    ) {
      this.cells[start + target] = blankCell(this.foreground, this.background);
    }
  }

  private eraseCharacters(count: number): void {
    const start = this.row * this.columns;
    const column = Math.min(this.column, this.columns - 1);
    const end = Math.min(column + count, this.columns);
    for (let target = column; target < end; target += 1) {
      this.cells[start + target] = blankCell(this.foreground, this.background);
    }
  }

  private eraseDisplay(mode: number): void {
    const cursor =
      this.row * this.columns + Math.min(this.column, this.columns - 1);
    switch (mode) {
      case 0:
        this.blankRange(cursor, this.cells.length);
        break;
      case 1:
        this.blankRange(0, cursor + 1);
        break;
      case 2:
      case 3:
        this.blankRange(0, this.cells.length);
        break;
      default:
        break;
    }
  }

  private eraseLine(mode: number): void {
    const start = this.row * this.columns;
    const column = Math.min(this.column, this.columns - 1);
    switch (mode) {
      case 0:
        this.blankRange(start + column, start + this.columns);
        break;
      case 1:
        this.blankRange(start, start + column + 1);
        break;
      case 2:
        this.blankRange(start, start + this.columns);
        break;
      default:
        break;
    }
  }

  private blankRange(start: number, end: number): void {
    for (let index = start; index < end; index += 1) {
      this.cells[index] = blankCell(this.foreground, this.background);
    }
  }

  private reset(): void {
    this.column = 0;
    this.row = 0;
    this.savedColumn = 0;
    this.savedRow = 0;
    this.altSavedColumn = 0;
    this.altSavedRow = 0;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.cursorVisible = true;
    this.resetAttributes();
    this.cells = this.blankGrid();
  }

  private resetAttributes(): void {
    this.foreground = DEFAULT_FOREGROUND;
    this.background = DEFAULT_BACKGROUND;
    this.bold = false;
    this.inverse = false;
  }
}

/** xterm 256-color index to 0xRRGGBB, reusing the 16-color palette. */
function indexedColor(index: number): number {
  if (index < 8) {
    return ANSI_NORMAL[index];
  }
  if (index < 16) {
    return ANSI_BRIGHT[index - 8];
  }
  if (index < 232) {
    const value = index - 16;
    const scale = [0, 95, 135, 175, 215, 255] as const;
    const red = scale[Math.floor(value / 36) % 6];
    const green = scale[Math.floor(value / 6) % 6];
    const blue = scale[value % 6];
    return (red << 16) | (green << 8) | blue;
  }
  if (index < 256) {
    const gray = 8 + (index - 232) * 10;
    return (gray << 16) | (gray << 8) | gray;
  }
  return DEFAULT_FOREGROUND;
}

const keyEncoder = new TextEncoder();

const SPECIAL_KEY_BYTES: Partial<Record<string, readonly number[]>> = {
  Enter: [0x0d],
  Backspace: [0x7f],
  Tab: [0x09],
  Escape: [0x1b],
  ArrowUp: [0x1b, 0x5b, 0x41],
  ArrowDown: [0x1b, 0x5b, 0x42],
  ArrowRight: [0x1b, 0x5b, 0x43],
  ArrowLeft: [0x1b, 0x5b, 0x44],
  Home: [0x1b, 0x5b, 0x48],
  End: [0x1b, 0x5b, 0x46],
  Insert: [0x1b, 0x5b, 0x32, 0x7e],
  Delete: [0x1b, 0x5b, 0x33, 0x7e],
  PageUp: [0x1b, 0x5b, 0x35, 0x7e],
  PageDown: [0x1b, 0x5b, 0x36, 0x7e],
};

const CONTROL_CHORDS: Partial<Record<string, number>> = {
  " ": 0x00,
  "@": 0x00,
  "[": 0x1b,
  "\\": 0x1c,
  "]": 0x1d,
  "^": 0x1e,
  _: 0x1f,
  "?": 0x7f,
};

/**
 * Translates browser KeyboardEvent semantics into the TTY bytes the Rust
 * `TtyKeyboard` emits. Returns null for modifier-only and unhandled keys.
 */
export function keyEventToBytes(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): Uint8Array | null {
  let bytes: number[] | null = null;

  const special = SPECIAL_KEY_BYTES[event.key];
  const firstCodePoint = event.key.codePointAt(0) ?? 0;
  const isSingleCharacter =
    event.key.length === (firstCodePoint > 0xffff ? 2 : 1);
  if (special !== undefined) {
    bytes = [...special];
  } else if (isSingleCharacter) {
    if (event.ctrlKey) {
      const lower = event.key.toLowerCase();
      const code = lower.charCodeAt(0);
      const chord = CONTROL_CHORDS[event.key];
      if (lower.length === 1 && code >= 0x61 && code <= 0x7a) {
        bytes = [code - 0x60];
      } else if (chord !== undefined) {
        bytes = [chord];
      } else {
        return null;
      }
    } else {
      bytes = [...keyEncoder.encode(event.key)];
    }
  }

  if (bytes === null) {
    return null;
  }
  if (event.altKey) {
    bytes.unshift(ESCAPE);
  }
  return Uint8Array.from(bytes);
}
