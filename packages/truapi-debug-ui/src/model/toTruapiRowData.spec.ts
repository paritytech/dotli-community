// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { nth } from '@dotli/shared/testing';
import { buildTruapiEvent, type BuildTruapiEventParams } from '../testing/buildTruapiEvent.js';
import { createEventStore } from './createEventStore.js';
import { toTruapiRowData } from './toTruapiRowData.js';

describe('toTruapiRowData()', () => {
  it.each<{ story: string; message: BuildTruapiEventParams; summary: string }>([
    {
      story: 'a block hash by its head and tail',
      message: { tag: 'remote_chain_head_body_request', value: { hash: `0x${'ab'.repeat(32)}` } },
      summary: 'blk 0xababab…abab',
    },
    {
      story: 'a long operation id by its head',
      message: {
        tag: 'remote_chain_head_body_response',
        direction: 'incoming',
        value: { success: true, value: { tag: 'Started', value: { operationId: 'operation-12345' } } },
      },
      summary: 'op operatio…',
    },
    {
      story: 'a short operation id whole',
      message: {
        tag: 'remote_chain_head_body_response',
        direction: 'incoming',
        value: { success: true, value: { tag: 'Started', value: { operationId: 'op-7' } } },
      },
      summary: 'op op-7',
    },
  ])('As a dotli developer, I see a chain message row show $story', ({ message, summary }) => {
    // Given
    const store = createEventStore({ capacity: 1 });
    store.insertTruapi(buildTruapiEvent(message));

    // When
    const row = toTruapiRowData(
      nth(
        store.list().filter(event => event.kind === 'truapi'),
        0,
      ),
    );

    // Then
    expect(row.summary).toBe(summary);
  });

  it.each<{ story: string; message: BuildTruapiEventParams; failed: boolean }>([
    {
      story: 'a chain response that reports an error',
      message: {
        tag: 'remote_chain_head_header_response',
        direction: 'incoming',
        value: { tag: 'V1', value: { success: false, value: { reason: 'block not pinned' } } },
      },
      failed: true,
    },
    {
      story: 'any other response whose result failed',
      message: {
        tag: 'host_account_get_response',
        direction: 'incoming',
        value: { tag: 'V1', value: { success: false, value: 'denied' } },
      },
      failed: true,
    },
    {
      story: 'a response whose result succeeded',
      message: {
        tag: 'host_account_get_response',
        direction: 'incoming',
        value: { tag: 'V1', value: { success: true, value: {} } },
      },
      failed: false,
    },
  ])('As a dotli developer, I see whether a row reports a failed call for $story', ({ message, failed }) => {
    // Given
    const store = createEventStore({ capacity: 1 });
    store.insertTruapi(buildTruapiEvent(message));

    // When
    const row = toTruapiRowData(
      nth(
        store.list().filter(event => event.kind === 'truapi'),
        0,
      ),
    );

    // Then
    expect(row.failed).toBe(failed);
  });
});
