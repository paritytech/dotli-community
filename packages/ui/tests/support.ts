// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Shared fixtures and helpers for the ui test suites.

import type { Result } from 'neverthrow';

export const genesisHash = `0x${'11'.repeat(32)}` as const;
export const blockHash = `0x${'22'.repeat(32)}` as const;

export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.isErr()) {
    throw new Error(`expected Ok, got Err: ${String(result.error)}`, {
      cause: result.error,
    });
  }
  return result.value;
}

export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what}, got ${String(value)}`);
  }
  return value;
}

type ElementClass<E extends Element> = abstract new (...args: never[]) => E;

function asElement<E extends Element>(node: Element | null, type: ElementClass<E>, what: string): E {
  const element = must(node, what);
  if (!(element instanceof type)) {
    throw new Error(`expected ${what} to be a ${type.name}`);
  }
  return element;
}

export function byId(id: string): HTMLElement;
export function byId<E extends Element>(id: string, type: ElementClass<E>): E;
export function byId(id: string, type: ElementClass<Element> = HTMLElement): Element {
  return asElement(document.getElementById(id), type, `#${id}`);
}

export function query(root: ParentNode, selector: string): HTMLElement;
export function query<E extends Element>(root: ParentNode, selector: string, type: ElementClass<E>): E;
export function query(root: ParentNode, selector: string, type: ElementClass<Element> = HTMLElement): Element {
  return asElement(root.querySelector(selector), type, `"${selector}"`);
}

export function byTestId(id: string, root?: ParentNode): HTMLElement;
export function byTestId<E extends Element>(id: string, root: ParentNode, type: ElementClass<E>): E;
export function byTestId(id: string, root: ParentNode = document, type: ElementClass<Element> = HTMLElement): Element {
  return query(root, `[data-testid="${id}"]`, type);
}

/** Narrows an iterator step, whose value an async iterator types as `any`, throwing if the iterator finished. */
export function yielded<T>(step: IteratorResult<T, unknown>): T {
  if (step.done === true) {
    throw new Error('expected a yielded value, the iterator finished');
  }
  return step.value;
}

export function hexBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
