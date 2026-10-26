// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { serializeError } from './serializeError.js';

type ScalarCase = {
  label: string;
  thrown: unknown;
  text: string;
};

describe('serializeError', () => {
  it.each<ScalarCase>([
    { label: 'null', thrown: null, text: 'null' },
    { label: 'undefined', thrown: undefined, text: 'undefined' },
    { label: 'string', thrown: 'boom', text: 'boom' },
    { label: 'empty string', thrown: '', text: 'Unknown error' },
    { label: 'number', thrown: 42, text: '42' },
    { label: 'boolean', thrown: false, text: 'false' },
  ])('As an operator reading a failure, I serialize a thrown $label and read it as $text', ({ thrown, text }) => {
    // Given the thrown value of the row

    // When
    const serialized = serializeError(thrown);

    // Then
    expect(serialized).toBe(text);
  });

  it('As an operator reading a failure, I serialize an Error and read its message', () => {
    // Given
    const error = new Error('kaboom');

    // When
    const serialized = serializeError(error);

    // Then
    expect(serialized).toBe('kaboom');
  });

  it('As an operator reading a failure, I serialize an Error without a message and read its name (DOTLI-1K)', () => {
    // Given
    const error = new Error('');

    // When
    const serialized = serializeError(error);

    // Then
    expect(serialized).toBe('Error');
  });

  it('As an operator reading a failure, I serialize an Error subclass without a message and read its own name', () => {
    // Given
    class AlreadyDestroyedError extends Error {
      override name = 'AlreadyDestroyedError';
    }
    const error = new AlreadyDestroyedError('');

    // When
    const serialized = serializeError(error);

    // Then
    expect(serialized).toBe('AlreadyDestroyedError');
  });

  it('As an operator reading a failure, I serialize an Error with a cause and read the cause after it', () => {
    // Given
    const inner = new Error('inner boom');
    const outer = new Error('outer boom', { cause: inner });

    // When
    const serialized = serializeError(outer);

    // Then
    expect(serialized).toBe('outer boom (cause: inner boom)');
  });

  it('As an operator reading a failure, I serialize an Error whose cause is no Error and read the cause after it', () => {
    // Given
    const outer = new Error('outer boom', { cause: 'string cause' });

    // When
    const serialized = serializeError(outer);

    // Then
    expect(serialized).toBe('outer boom (cause: string cause)');
  });

  it('As an operator reading a failure, I serialize an Error whose causes cycle and read each once, without recursing forever', () => {
    // Given
    const first = new Error('a');
    const second = new Error('b');
    first.cause = second;
    second.cause = first;

    // When
    const serialized = serializeError(first);

    // Then
    expect(serialized).toBe('a (cause: b (cause: [cycle]))');
  });

  it('As an operator reading a failure, I serialize an AggregateError and read its inner errors', () => {
    // Given
    const aggregate = new AggregateError([new Error('first'), new Error('second')], 'all failed');

    // When
    const serialized = serializeError(aggregate);

    // Then
    expect(serialized).toBe('all failed [first; second]');
  });

  it('As an operator reading a failure, I serialize an AggregateError and read at most 3 of its inner errors', () => {
    // Given
    const aggregate = new AggregateError(
      [new Error('a'), new Error('b'), new Error('c'), new Error('d'), new Error('e')],
      'many failed',
    );

    // When
    const serialized = serializeError(aggregate);

    // Then
    expect(serialized).toBe('many failed [a; b; c, ...]');
  });

  it('As an operator reading a failure, I serialize a thrown object and read its message', () => {
    // Given
    const thrown = { message: 'plain object error' };

    // When
    const serialized = serializeError(thrown);

    // Then
    expect(serialized).toBe('plain object error');
  });

  it('As an operator reading a failure, I serialize a thrown object with an empty message and read its JSON', () => {
    // Given
    const thrown = { message: '', code: 42 };

    // When
    const serialized = serializeError(thrown);

    // Then
    expect(serialized).toBe('{"message":"","code":42}');
  });

  it('As an operator reading a failure, I serialize a thrown object without a message and read its JSON', () => {
    // Given
    const thrown = { code: -32603 };

    // When
    const serialized = serializeError(thrown);

    // Then
    expect(serialized).toBe('{"code":-32603}');
  });

  it('As an operator reading a failure, I serialize an empty thrown object and read [object Object]', () => {
    // Given
    const thrown = {};

    // When
    const serialized = serializeError(thrown);

    // Then
    expect(serialized).toBe('[object Object]');
  });

  it('As an operator reading a failure, I serialize a thrown object that refers to itself and the report does not fail', () => {
    // Given
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    // When
    const serialized = serializeError(cyclic);

    // Then
    expect(serialized).toBe('[object Object]');
  });

  it('As an operator reading a failure, I serialize anything thrown and never read an empty string', () => {
    // Given
    const inputs: unknown[] = [null, undefined, '', 0, false, {}, [], new Error(''), new Error(), { message: '' }];

    // When
    const serialized = inputs.map(value => serializeError(value));

    // Then
    expect(serialized).not.toContain('');
  });
});
