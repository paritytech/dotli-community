// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { getRidColor } from '../model/getRidColor.js';
import s from './IdBadge.module.css';

/** Ids of one flow often share a head and differ at the end, so a narrow badge cuts the head and keeps these. */
const KEPT_TAIL_LENGTH = 4;

/**
 * An id tinted by a hash of it, so everything of one request or flow shares a colour. In a column too narrow for it,
 * its head ends in an ellipsis and its last characters stay.
 */
export function IdBadge(props: {
  id: string;
  testId: string;
  title?: string | undefined;
  class?: string | undefined;
}): JSX.Element {
  const cut = (): number => (props.id.length > KEPT_TAIL_LENGTH * 2 ? props.id.length - KEPT_TAIL_LENGTH : 0);
  return (
    <span
      class={[s['badge'], props.class]}
      data-testid={props.testId}
      style={{ color: getRidColor(props.id) }}
      title={props.title}
    >
      <span class={s['head']}>{props.id.slice(0, cut())}</span>
      <span class={s['tail']}>{props.id.slice(cut())}</span>
    </span>
  );
}
