// dot.li — Hex utilities for binary ↔ 0x-prefixed string conversion.

export type HexString = `0x${string}`;

export function toHex(bytes: Uint8Array): HexString {
  const chars: string[] = [];
  for (const byte of bytes) {
    chars.push(byte.toString(16).padStart(2, "0"));
  }
  return `0x${chars.join("")}`;
}

export function fromHex(hex: string): Uint8Array {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length % 2 !== 0) {
    throw new Error("invalid hex string: odd length");
  }
  const bytes = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
