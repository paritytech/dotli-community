import { SITE_ID } from "@dotli/config/config";
import { bytesToHex, hexToBytes } from "@parity/truapi/scale";
import type { HostCallbacks } from "@parity/truapi-host-wasm";
import {
  buildSharedAuthStorageKey,
  SHARED_CORE_SESSION_KEY,
} from "@dotli/protocol/auth-storage";
import { createResultStream } from "./result-stream";

const LOCAL_CHANGE_EVENT = "dotli:truapi-session-store-changed";
const STORAGE_KEY = buildSharedAuthStorageKey(SITE_ID, SHARED_CORE_SESSION_KEY);
const CHANNEL_NAME = `dotli:truapi-session-store:${SITE_ID}`;

function emitLocalChange(): void {
  window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT));
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(undefined);
    channel.close();
  } catch {
    /* BroadcastChannel unavailable: same-tab event and storage event still cover common cases. */
  }
}

interface TruapiSessionUiState {
  connected: boolean;
  publicKey?: string;
  identityAccountId?: string;
  liteUsername?: string;
  fullUsername?: string;
  primaryUsername?: string;
}

function emitSessionUiState(detail: TruapiSessionUiState): void {
  window.dispatchEvent(
    new CustomEvent("dotli:truapi-session-state", { detail }),
  );
}

function emitConnectedSessionUiState(value: Uint8Array): void {
  emitSessionUiState(decodeSessionUiState(value) ?? { connected: true });
}

function decodeSessionUiState(value: Uint8Array): TruapiSessionUiState | null {
  try {
    const cursor = new ScaleCursor(value);
    const version = cursor.u8();
    if (version !== 2 && version !== 3) {
      return null;
    }
    const publicKey = bytesToHex(cursor.bytes(32));
    cursor.skipOptionFixed(385);
    cursor.skipOptionFixed(32);
    const identityAccountId =
      version >= 3 ? cursor.optionFixedHex(32) : undefined;
    const liteUsername = cursor.optionString();
    const fullUsername = cursor.optionString();
    return {
      connected: true,
      publicKey,
      ...(identityAccountId !== undefined ? { identityAccountId } : {}),
      ...(liteUsername !== undefined ? { liteUsername } : {}),
      ...(fullUsername !== undefined ? { fullUsername } : {}),
      ...(fullUsername !== undefined || liteUsername !== undefined
        ? { primaryUsername: fullUsername ?? liteUsername }
        : {}),
    };
  } catch {
    return null;
  }
}

class ScaleCursor {
  private offset = 0;
  private readonly value: Uint8Array;

  constructor(value: Uint8Array) {
    this.value = value;
  }

  u8(): number {
    const byte = this.value[this.offset];
    if (byte === undefined) {
      throw new Error("unexpected end of session blob");
    }
    this.offset += 1;
    return byte;
  }

  bytes(length: number): Uint8Array {
    if (this.offset + length > this.value.length) {
      throw new Error("unexpected end of session blob");
    }
    const out = this.value.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  skipOptionFixed(length: number): void {
    const tag = this.u8();
    if (tag === 0) {
      return;
    }
    if (tag !== 1) {
      throw new Error("invalid option tag");
    }
    this.bytes(length);
  }

  optionFixedHex(length: number): string | undefined {
    const tag = this.u8();
    if (tag === 0) {
      return undefined;
    }
    if (tag !== 1) {
      throw new Error("invalid option tag");
    }
    return bytesToHex(this.bytes(length));
  }

  optionString(): string | undefined {
    const tag = this.u8();
    if (tag === 0) {
      return undefined;
    }
    if (tag !== 1) {
      throw new Error("invalid option tag");
    }
    const length = this.compactLength();
    const bytes = this.bytes(length);
    const text = new TextDecoder().decode(bytes);
    return text.length === 0 ? undefined : text;
  }

  private compactLength(): number {
    const first = this.u8();
    const mode = first & 0b11;
    if (mode === 0) {
      return first >> 2;
    }
    if (mode === 1) {
      return ((first >> 2) | (this.u8() << 6)) >>> 0;
    }
    if (mode === 2) {
      return (
        (first >> 2) |
        (this.u8() << 6) |
        (this.u8() << 14) |
        (this.u8() << 22)
      ) >>> 0;
    }
    const byteLength = (first >> 2) + 4;
    let length = 0;
    for (let i = 0; i < byteLength; i += 1) {
      length += this.u8() * 2 ** (8 * i);
    }
    return length;
  }
}

export function createSessionStoreAdapters(): Pick<
  HostCallbacks,
  "readSession" | "writeSession" | "clearSession" | "subscribeSessionStore"
> {
  return {
    async readSession() {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(STORAGE_KEY);
      } catch {
        raw = null;
      }
      if (raw === null || raw === "") {
        return undefined;
      }
      const value = hexToBytes(raw);
      emitConnectedSessionUiState(value);
      return value;
    },
    async writeSession(value) {
      localStorage.setItem(STORAGE_KEY, bytesToHex(value));
      emitLocalChange();
      emitConnectedSessionUiState(value);
    },
    async clearSession() {
      localStorage.removeItem(STORAGE_KEY);
      emitLocalChange();
      emitSessionUiState({ connected: false });
    },
    subscribeSessionStore() {
      return createResultStream<undefined>([undefined], (push) => {
        const onLocalChange = (): void => {
          push(undefined);
        };
        window.addEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
        const onStorage = (event: StorageEvent): void => {
          if (event.key === STORAGE_KEY) {
            push(undefined);
          }
        };
        window.addEventListener("storage", onStorage);
        let channel: BroadcastChannel | null = null;
        try {
          channel = new BroadcastChannel(CHANNEL_NAME);
          channel.addEventListener("message", onLocalChange);
        } catch {
          channel = null;
        }
        return () => {
          window.removeEventListener(LOCAL_CHANGE_EVENT, onLocalChange);
          window.removeEventListener("storage", onStorage);
          if (channel !== null) {
            channel.removeEventListener("message", onLocalChange);
            channel.close();
          }
        };
      });
    },
  };
}
