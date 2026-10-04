// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { Field } from '../../../src/components/primitives/Field.js';
import { Callout, KeyValue, Row, Well } from '../../../src/components/primitives/Well.js';
import { renderComponent } from '../../helpers/solid.js';
import { byTestId } from '../../support.js';

describe('Well and its parts', () => {
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

  it('As a reviewer of a signing request, I read each field label over its value', () => {
    // Given / When
    renderComponent(() => (
      <Field label="Signer" value="alice" labelTestId="field-label" valueTestId="field-value" testId="field" />
    ));

    // Then
    expect(byTestId('field-label').textContent).toBe('Signer');
    expect(byTestId('field-value').textContent).toBe('alice');
  });
});
