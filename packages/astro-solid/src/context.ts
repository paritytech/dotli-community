// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { RendererContext } from './types.js';

interface Context {
  readonly id: string;
  c: number;
  /** Style dedupe keys already emitted into an island on this page render. */
  styles: Set<string>;
}

const contexts = new WeakMap<RendererContext['result'], Context>();

/** The per-page render state: island ids and emitted styles. */
export function getContext(result: RendererContext['result']): Context {
  const existing = contexts.get(result);
  if (existing !== undefined) {
    return existing;
  }
  const ctx: Context = {
    c: 0,
    styles: new Set<string>(),
    get id() {
      return 's' + this.c.toString();
    },
  };
  contexts.set(result, ctx);
  return ctx;
}

/** The next island's render id on this page. */
export function incrementId(ctx: Context): string {
  const id = ctx.id;
  ctx.c++;
  return id;
}
