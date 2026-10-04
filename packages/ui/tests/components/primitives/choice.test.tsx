// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { Choice } from '../../../src/components/primitives/Choice.js';
import { renderComponent } from '../../helpers/solid.js';
import { byTestId, query } from '../../support.js';

describe('Choice', () => {
  it('As a user, I pick a transport and its owner hears the choice without the radio checking itself', () => {
    // Given
    const onChoose = vi.fn();
    renderComponent(() => (
      <Choice
        title="Light client"
        description="Checked in your browser."
        selected={false}
        radio={{ name: 'transport', value: 'smoldot', onChoose }}
        testId="choice"
      />
    ));
    const input = query(byTestId('choice'), 'input[type="radio"]', HTMLInputElement);

    // When
    input.click();

    // Then
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(input.checked).toBe(false);
    expect(input.name).toBe('transport');
    expect(input.value).toBe('smoldot');
  });

  it('As a user, I pick another transport that its owner refuses, and the current one stays checked', () => {
    // Given
    const onChoose = vi.fn();
    renderComponent(() => (
      <>
        <Choice
          title="Light client"
          description="Checked in your browser."
          selected={true}
          radio={{ name: 'transport', value: 'smoldot', onChoose: () => {} }}
          testId="current"
        />
        <Choice
          title="RPC gateway"
          description="Served by a provider."
          selected={false}
          radio={{ name: 'transport', value: 'rpc', onChoose }}
          testId="other"
        />
      </>
    ));
    const current = query(byTestId('current'), 'input[type="radio"]', HTMLInputElement);
    const other = query(byTestId('other'), 'input[type="radio"]', HTMLInputElement);
    expect(current.checked).toBe(true);

    // When
    other.click();

    // Then
    // A browser also re-checks the current radio when the click is cancelled
    // (checked in Chromium). happy-dom only restores the clicked one, so that
    // half is not asserted here.
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(other.checked).toBe(false);
  });

  it('As a user, I cannot pick a disabled choice', () => {
    // Given
    const onChoose = vi.fn();
    renderComponent(() => (
      <Choice
        title="Shared worker"
        description="Unavailable in this browser."
        selected={false}
        radio={{ name: 'transport', value: 'shared', disabled: true, onChoose }}
        testId="choice"
      />
    ));
    const input = query(byTestId('choice'), 'input[type="radio"]', HTMLInputElement);

    // When
    input.click();

    // Then
    expect(input.disabled).toBe(true);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('As a user, I read a static choice with no control in it', () => {
    // Given / When
    renderComponent(() => (
      <Choice title="Verified" description="Checked by the light client." selected={true} testId="choice" />
    ));

    // Then
    const card = byTestId('choice');
    expect(card.querySelector('input')).toBeNull();
    expect(card.textContent).toContain('Verified');
    expect(card.textContent).toContain('Checked by the light client.');
  });
});
