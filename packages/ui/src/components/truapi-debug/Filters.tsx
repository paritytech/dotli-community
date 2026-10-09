// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Only edits the filter state. Matching lives in `@dotli/truapi-debug`.

import { For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { compileQuery, type DirectionFilter, type DockPosition, type FilterState } from '@dotli/truapi-debug';
import s from './Filters.module.css';

const DIRECTIONS: readonly { dir: DirectionFilter; label: string }[] = [
  { dir: 'both', label: 'both' },
  { dir: 'outgoing', label: '▶ out' },
  { dir: 'incoming', label: '◀ in' },
];

function productKey(p: string | undefined): string {
  return p ?? '__anon';
}

export function Filters(props: {
  filters: FilterState;
  /** Sorted, `undefined` last. */
  products: readonly (string | undefined)[];
  placement: DockPosition;
  collapsed: boolean;
  /** The active view does not filter events (Wallet). */
  hidden: boolean;
  onChange: (next: FilterState) => void;
}): JSX.Element {
  const update = (patch: Partial<FilterState>): void => {
    props.onChange({ ...props.filters, ...patch });
  };

  const on = (active: boolean): '' | undefined => (active ? '' : undefined);
  const invalid = (query: string): 'true' | undefined => (compileQuery(query).invalid ? 'true' : undefined);

  return (
    <div
      class={s['filters']}
      data-testid="td-filters"
      data-dock={props.placement}
      data-collapsed={on(props.collapsed)}
      hidden={props.hidden}
    >
      <div class={s['group']}>
        <span class={s['label']}>show</span>
        <label class={s['check']}>
          <input
            type="checkbox"
            class={s['checkbox']}
            data-testid="td-kind"
            data-kind="truapi"
            checked={props.filters.showTruapi}
            onChange={e => {
              update({ showTruapi: e.currentTarget.checked });
            }}
          />{' '}
          TrUAPI
        </label>
        <label class={s['check']}>
          <input
            type="checkbox"
            class={s['checkbox']}
            data-testid="td-kind"
            data-kind="system"
            checked={props.filters.showSystem}
            onChange={e => {
              update({ showSystem: e.currentTarget.checked });
            }}
          />{' '}
          System
        </label>
      </div>
      <div class={s['group']}>
        <span class={s['label']}>dir</span>
        <For each={DIRECTIONS}>
          {entry => (
            <button
              class={s['chip']}
              data-testid="td-dir"
              data-active={on(props.filters.direction === entry.dir)}
              data-dir={entry.dir}
              onClick={() => {
                update({ direction: entry.dir });
              }}
            >
              {entry.label}
            </button>
          )}
        </For>
      </div>
      <div class={s['group']}>
        <span class={s['label']}>product</span>
        <div>
          <button
            class={s['chip']}
            data-testid="td-product-chip"
            data-active={on(props.filters.product === undefined)}
            data-product="__all"
            onClick={() => {
              update({ product: undefined });
            }}
          >
            all
          </button>
          {/* Keyed so traffic keeps chip nodes and an in-flight click is never dropped. */}
          <For each={props.products} keyed={productKey}>
            {product => (
              <button
                class={s['chip']}
                data-testid="td-product-chip"
                data-active={on(props.filters.product === (product() ?? null))}
                data-product={productKey(product())}
                onClick={() => {
                  update({ product: product() ?? null });
                }}
              >
                {product() ?? '(no id)'}
              </button>
            )}
          </For>
        </div>
      </div>
      <div class={s['group']}>
        <span class={s['label']}>include</span>
        <input
          class={s['input']}
          data-testid="td-tag-input"
          aria-invalid={invalid(props.filters.tagQuery)}
          type="search"
          placeholder="filter by method…"
          title="substring or /regex/"
          spellcheck="false"
          autocomplete="off"
          onInput={e => {
            update({ tagQuery: e.currentTarget.value });
          }}
        />
      </div>
      <div class={s['group']}>
        <span class={s['label']}>exclude</span>
        <input
          class={s['input']}
          data-testid="td-exclude-input"
          aria-invalid={invalid(props.filters.excludeQuery)}
          type="search"
          placeholder="hide by method…"
          title="substring or /regex/"
          spellcheck="false"
          autocomplete="off"
          onInput={e => {
            update({ excludeQuery: e.currentTarget.value });
          }}
        />
      </div>
    </div>
  );
}
