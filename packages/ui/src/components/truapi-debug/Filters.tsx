// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Filter bar of the TrUAPI debug panel: kind checkboxes, direction chips,
// product chips and the include / exclude queries. Semantics live in
// `@dotli/truapi-debug/filters`; this component only edits the state.

import { For } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  compileQuery,
  type DirectionFilter,
  type FilterState,
} from "@dotli/truapi-debug";

const DIRECTIONS: readonly { dir: DirectionFilter; label: string }[] = [
  { dir: "both", label: "both" },
  { dir: "outgoing", label: "▶ out" },
  { dir: "incoming", label: "◀ in" },
];

/** Stable key per product chip; `undefined` is the events without an id. */
function productKey(p: string | undefined): string {
  return p ?? "__anon";
}

export function Filters(props: {
  filters: FilterState;
  /** Distinct product ids, sorted, `undefined` last. */
  products: readonly (string | undefined)[];
  onChange: (next: FilterState) => void;
}): JSX.Element {
  const update = (patch: Partial<FilterState>): void => {
    props.onChange({ ...props.filters, ...patch });
  };

  const chipClass = (base: string, active: boolean): string =>
    active ? `${base} active` : base;
  const inputClass = (base: string, query: string): string =>
    compileQuery(query).invalid ? `${base} invalid` : base;

  return (
    <div class="td-filters">
      <div class="td-filter-group td-kind-group">
        <span class="td-filter-label">show</span>
        <label class="td-kind-check">
          <input
            type="checkbox"
            class="td-kind"
            data-kind="truapi"
            checked={props.filters.showTruapi}
            onChange={(e) => {
              update({ showTruapi: e.currentTarget.checked });
            }}
          />{" "}
          TrUAPI
        </label>
        <label class="td-kind-check">
          <input
            type="checkbox"
            class="td-kind"
            data-kind="system"
            checked={props.filters.showSystem}
            onChange={(e) => {
              update({ showSystem: e.currentTarget.checked });
            }}
          />{" "}
          System
        </label>
      </div>
      <div class="td-filter-group td-dir-group">
        <span class="td-filter-label">dir</span>
        <For each={DIRECTIONS}>
          {(entry) => (
            <button
              class={chipClass(
                "td-chip td-dir",
                props.filters.direction === entry.dir,
              )}
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
      <div class="td-filter-group">
        <span class="td-filter-label">product</span>
        <div class="td-product-chips">
          <button
            class={chipClass(
              "td-chip td-product-chip",
              props.filters.product === undefined,
            )}
            data-product="__all"
            onClick={() => {
              update({ product: undefined });
            }}
          >
            all
          </button>
          {/* Keyed by product, so traffic from a known product keeps every
              chip node and an in-flight click on one is never dropped. */}
          <For each={props.products} keyed={productKey}>
            {(product) => (
              <button
                class={chipClass(
                  "td-chip td-product-chip",
                  props.filters.product === (product() ?? null),
                )}
                data-product={productKey(product())}
                onClick={() => {
                  update({ product: product() ?? null });
                }}
              >
                {product() ?? "(no id)"}
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="td-filter-group">
        <span class="td-filter-label">include</span>
        <input
          class={inputClass("td-input td-tag-input", props.filters.tagQuery)}
          type="search"
          placeholder="filter by method…"
          title="substring or /regex/"
          spellcheck="false"
          autocomplete="off"
          onInput={(e) => {
            update({ tagQuery: e.currentTarget.value });
          }}
        />
      </div>
      <div class="td-filter-group">
        <span class="td-filter-label">exclude</span>
        <input
          class={inputClass(
            "td-input td-exclude-input",
            props.filters.excludeQuery,
          )}
          type="search"
          placeholder="hide by method…"
          title="substring or /regex/"
          spellcheck="false"
          autocomplete="off"
          onInput={(e) => {
            update({ excludeQuery: e.currentTarget.value });
          }}
        />
      </div>
    </div>
  );
}
