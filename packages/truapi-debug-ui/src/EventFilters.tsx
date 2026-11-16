// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Only edits the filter state, and matches no event itself.

import { createMemo, createUniqueId, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { compileQuery } from './model/compileQuery.js';
import { DIRECTION_FILTERS, type DirectionFilter, type FilterState } from './model/filterState.js';
import { formatProductId } from './model/formatProductId.js';
import {
  FilterBar,
  FilterChips,
  FilterCheck,
  FilterGroup,
  FilterHint,
  FilterInput,
  type FilterChip,
} from './shared/Filters.js';
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
}): JSX.Element {
  const includeHintId = createUniqueId();
  const excludeHintId = createUniqueId();
  const includeInvalid = createMemo(() => compileQuery(props.filters.tagQuery).invalid);
  const excludeInvalid = createMemo(() => compileQuery(props.filters.excludeQuery).invalid);
  function updateFilters(patch: Partial<FilterState>): void {
    props.onChange({ ...props.filters, ...patch });
  }
  const productChips = createMemo((): FilterChip<string>[] => [
    { value: ALL_PRODUCTS, label: 'all' },
    ...props.products.map(product => ({ value: toProductChipValue(product ?? null), label: formatProductId(product) })),
  ]);

  return (
    <FilterBar testId="td-filters" hidden={props.hidden} class={s['filters']}>
      <div class={s['layout']}>
        <div class={s['line']}>
          <FilterGroup label="show" class={s['show']}>
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
          <FilterGroup label="dir" class={s['dir']}>
            <FilterChips
              testId="td-dir"
              chips={DIRECTIONS}
              selected={props.filters.direction}
              onSelect={direction => {
                updateFilters({ direction });
              }}
            />
          </FilterGroup>
        </div>
        <div class={s['line']}>
          <FilterGroup label="product" class={s['product']}>
            <FilterChips
              testId="td-product-chip"
              scroll
              chips={productChips()}
              selected={toProductChipValue(props.filters.product)}
              onSelect={value => {
                updateFilters({ product: toProductFilter(value) });
              }}
            />
          </FilterGroup>
        </div>
        <div class={s['line']}>
          <FilterGroup label="include" field class={s['include']}>
            <FilterInput
              testId="td-tag-input"
              label="Include methods"
              placeholder="method…"
              title={QUERY_TITLE}
              invalid={includeInvalid()}
              hintId={includeHintId}
              onInput={tagQuery => {
                updateFilters({ tagQuery });
              }}
            />
          </FilterGroup>
          <FilterGroup label="exclude" field class={s['exclude']}>
            <FilterInput
              testId="td-exclude-input"
              label="Exclude methods"
              placeholder="method…"
              title={QUERY_TITLE}
              invalid={excludeInvalid()}
              hintId={excludeHintId}
              onInput={excludeQuery => {
                updateFilters({ excludeQuery });
              }}
            />
          </FilterGroup>
        </div>
        <Show when={includeInvalid() || excludeInvalid()}>
          <div class={s['hints']}>
            <Show when={includeInvalid()}>
              <FilterHint id={includeHintId}>Invalid include regex, so that filter is off.</FilterHint>
            </Show>
            <Show when={excludeInvalid()}>
              <FilterHint id={excludeHintId}>Invalid exclude regex, so that filter is off.</FilterHint>
            </Show>
          </div>
        </Show>
      </div>
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
