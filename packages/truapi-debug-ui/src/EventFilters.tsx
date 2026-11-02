// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Only edits the filter state, and matches no event itself.

import { createMemo } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { compileQuery } from './model/compileQuery.js';
import { DIRECTION_FILTERS, type DirectionFilter, type FilterState } from './model/filterState.js';
import { formatProductId } from './model/formatProductId.js';
import { FilterBar, FilterChips, FilterCheck, FilterGroup, FilterInput, type FilterChip } from './shared/Filters.js';
import { IncomingIcon } from './icons/IncomingIcon.js';
import { OutgoingIcon } from './icons/OutgoingIcon.js';
import s from './EventFilters.module.css';

const DIRECTION_CHIPS: Record<DirectionFilter, Omit<FilterChip<DirectionFilter>, 'value'>> = {
  both: { label: 'both' },
  outgoing: { label: 'out', icon: OutgoingIcon },
  incoming: { label: 'in', icon: IncomingIcon },
};

const DIRECTIONS: readonly FilterChip<DirectionFilter>[] = DIRECTION_FILTERS.map(direction => ({
  value: direction,
  ...DIRECTION_CHIPS[direction],
}));

const ALL_PRODUCTS = '__all';
const NO_PRODUCT_ID = '__anon';

const QUERY_TITLE = 'substring or /regex/';

export function EventFilters(props: {
  filters: FilterState;
  /** Sorted, `undefined` last. */
  products: readonly (string | undefined)[];
  /** While the panel is collapsed or shows another tab than TrUAPI. */
  hidden: boolean;
  onChange: (next: FilterState) => void;
  /** The log's own controls, at the row's end. */
  controls: JSX.Element;
}): JSX.Element {
  function updateFilters(patch: Partial<FilterState>): void {
    props.onChange({ ...props.filters, ...patch });
  }
  const productChips = createMemo((): FilterChip<string>[] => [
    { value: ALL_PRODUCTS, label: 'all' },
    ...props.products.map(product => ({ value: toProductChipValue(product ?? null), label: formatProductId(product) })),
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
            updateFilters({ showTruapi: checked });
          }}
        />
        <FilterCheck
          testId="td-kind"
          value="system"
          label="System"
          checked={props.filters.showSystem}
          onChange={checked => {
            updateFilters({ showSystem: checked });
          }}
        />
      </FilterGroup>
      <FilterGroup label="dir">
        <FilterChips
          testId="td-dir"
          chips={DIRECTIONS}
          selected={props.filters.direction}
          onSelect={direction => {
            updateFilters({ direction });
          }}
        />
      </FilterGroup>
      <FilterGroup label="product">
        <FilterChips
          testId="td-product-chip"
          chips={productChips()}
          selected={toProductChipValue(props.filters.product)}
          onSelect={value => {
            updateFilters({ product: toProductFilter(value) });
          }}
        />
      </FilterGroup>
      <FilterGroup label="include">
        <FilterInput
          testId="td-tag-input"
          label="Include methods"
          placeholder="filter by method…"
          title={QUERY_TITLE}
          invalid={compileQuery(props.filters.tagQuery).invalid}
          onInput={tagQuery => {
            updateFilters({ tagQuery });
          }}
        />
      </FilterGroup>
      <FilterGroup label="exclude">
        <FilterInput
          testId="td-exclude-input"
          label="Exclude methods"
          placeholder="hide by method…"
          title={QUERY_TITLE}
          invalid={compileQuery(props.filters.excludeQuery).invalid}
          onInput={excludeQuery => {
            updateFilters({ excludeQuery });
          }}
        />
      </FilterGroup>
      {props.controls}
    </FilterBar>
  );
}

/** A chip value per product filter: every product, events with no product id, or one product. */
function toProductChipValue(product: string | null | undefined): string {
  if (product === undefined) {
    return ALL_PRODUCTS;
  }
  return product ?? NO_PRODUCT_ID;
}

function toProductFilter(value: string): string | null | undefined {
  if (value === ALL_PRODUCTS) {
    return undefined;
  }
  return value === NO_PRODUCT_ID ? null : value;
}
