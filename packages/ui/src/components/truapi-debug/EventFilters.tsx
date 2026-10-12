// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Only edits the filter state. Matching lives in `@dotli/truapi-debug`.

import { createMemo } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { compileQuery, type DirectionFilter, type FilterState } from '@dotli/truapi-debug';
import { FilterBar, FilterChips, FilterCheck, FilterGroup, FilterInput, type FilterChip } from './shared/Filters.js';
import s from './EventFilters.module.css';

const DIRECTIONS: readonly FilterChip<DirectionFilter>[] = [
  { value: 'both', label: 'both' },
  { value: 'outgoing', label: '▶ out' },
  { value: 'incoming', label: '◀ in' },
];

const ALL_PRODUCTS = '__all';
const NO_PRODUCT_ID = '__anon';

/** A chip value per product filter: every product, events with no product id, or one product. */
function productChipValue(product: string | null | undefined): string {
  if (product === undefined) {
    return ALL_PRODUCTS;
  }
  return product ?? NO_PRODUCT_ID;
}

function productFilter(value: string): string | null | undefined {
  if (value === ALL_PRODUCTS) {
    return undefined;
  }
  return value === NO_PRODUCT_ID ? null : value;
}

const QUERY_TITLE = 'substring or /regex/';

export function EventFilters(props: {
  filters: FilterState;
  /** Sorted, `undefined` last. */
  products: readonly (string | undefined)[];
  /** While the panel is collapsed or shows another tab than TrUAPI. */
  hidden: boolean;
  onChange: (next: FilterState) => void;
}): JSX.Element {
  const update = (patch: Partial<FilterState>): void => {
    props.onChange({ ...props.filters, ...patch });
  };
  const productChips = createMemo((): FilterChip<string>[] => [
    { value: ALL_PRODUCTS, label: 'all' },
    ...props.products.map(product => ({ value: productChipValue(product ?? null), label: product ?? '(no id)' })),
  ]);

  return (
    <FilterBar testId="td-filters" hidden={props.hidden} class={s['filters']}>
      <FilterGroup label="show">
        <FilterCheck
          testId="td-kind"
          value="truapi"
          label="TrUAPI"
          checked={props.filters.showTruapi}
          onChange={checked => {
            update({ showTruapi: checked });
          }}
        />
        <FilterCheck
          testId="td-kind"
          value="system"
          label="System"
          checked={props.filters.showSystem}
          onChange={checked => {
            update({ showSystem: checked });
          }}
        />
      </FilterGroup>
      <FilterGroup label="dir">
        <FilterChips
          testId="td-dir"
          chips={DIRECTIONS}
          selected={props.filters.direction}
          onSelect={direction => {
            update({ direction });
          }}
        />
      </FilterGroup>
      <FilterGroup label="product">
        <FilterChips
          testId="td-product-chip"
          chips={productChips()}
          selected={productChipValue(props.filters.product)}
          onSelect={value => {
            update({ product: productFilter(value) });
          }}
        />
      </FilterGroup>
      <FilterGroup label="include">
        <FilterInput
          testId="td-tag-input"
          placeholder="filter by method…"
          title={QUERY_TITLE}
          invalid={compileQuery(props.filters.tagQuery).invalid}
          onInput={tagQuery => {
            update({ tagQuery });
          }}
        />
      </FilterGroup>
      <FilterGroup label="exclude">
        <FilterInput
          testId="td-exclude-input"
          placeholder="hide by method…"
          title={QUERY_TITLE}
          invalid={compileQuery(props.filters.excludeQuery).invalid}
          onInput={excludeQuery => {
            update({ excludeQuery });
          }}
        />
      </FilterGroup>
    </FilterBar>
  );
}
