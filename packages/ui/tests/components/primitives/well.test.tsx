// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Field } from '../../../src/components/primitives/Field.js';
import { Callout, KeyValue, Row, Well } from '../../../src/components/primitives/Well.js';
import { renderComponent, settle } from '../../helpers/solid.js';
import { byTestId } from '../../support.js';

describe('Well and its parts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('As a user, I read each row label beside its control, and each key beside its value', () => {
    // Given / When
    renderComponent(() => (
      <>
        <Well layout="controls" testId="well">
          <Row label="Camera" testId="row">
            <button type="button">Ask</button>
          </Row>
        </Well>
        <Well layout="kv">
          <KeyValue k="Build" v="0.9.3" testId="kv" />
        </Well>
        <Callout testId="callout">Changes reload the app</Callout>
      </>
    ));

    // Then
    expect(byTestId('row').textContent).toBe('CameraAsk');
    expect(byTestId('kv').textContent).toBe('Build0.9.3');
    expect(byTestId('callout').textContent).toBe('Changes reload the app');
    expect(byTestId('well').contains(byTestId('row'))).toBe(true);
  });

  it('As a user, I click a copyable key-value row and its handler runs', () => {
    // Given
    const onClick = vi.fn();
    renderComponent(() => (
      <Well layout="kv">
        <KeyValue k="Site" v="dot.li" copyable title="Click to copy Site" onClick={onClick} testId="kv" />
      </Well>
    ));
    const row = byTestId('kv');

    // Then
    expect(row.hasAttribute('data-copyable')).toBe(true);
    expect(row.getAttribute('title')).toBe('Click to copy Site');
    expect(row.children[1]?.tagName).toBe('BUTTON');
    expect(row.children[1]?.textContent).toBe('Copy Site dot.li');

    // When
    row.click();

    // Then
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('As a reviewer of a signing request, I read each field label over its value', () => {
    // Given / When
    renderComponent(() => (
      <Field label="Signer" value="alice" labelTestId="field-label" valueTestId="field-value" testId="field" />
    ));

    // Then
    expect(byTestId('field-label').textContent).toBe('Signer');
    expect(byTestId('field-value').textContent).toBe('alice');
  });

  it('As a keyboard user, a call-data value that scrolls is a named region in the Tab order', async () => {
    // Given
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(120);

    // When
    renderComponent(() => <Field label="Call Data" value="0x1234" mono valueTestId="field-value" />);
    await settle();

    // Then
    const value = byTestId('field-value');
    expect(value.getAttribute('role')).toBe('region');
    expect(value.getAttribute('aria-label')).toBe('Call Data');
    expect(value.tabIndex).toBe(0);
  });

  it('As a keyboard user, a call-data value that fits its box is plain text, not a Tab stop', async () => {
    // Given
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(40);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);

    // When
    renderComponent(() => <Field label="Call Data" value="0x1234" mono valueTestId="field-value" />);
    await settle();

    // Then
    const value = byTestId('field-value');
    expect(value.hasAttribute('role')).toBe(false);
    expect(value.hasAttribute('aria-label')).toBe(false);
    expect(value.hasAttribute('tabindex')).toBe(false);
  });
});
