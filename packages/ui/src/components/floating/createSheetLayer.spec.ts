// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { recordReports } from '@dotli/metrics/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createSheetLayer } from './createSheetLayer.js';

describe('createSheetLayer', () => {
  it('As a sheet opened inside a hand-off, I open handed off', () => {
    // Given a hand-off that a sheet that opens takes
    const { handOff, layer } = setup();
    handOff.taking = true;

    // When the sheet opens
    layer.update({ kind: 'opened' });

    // Then it is open, handed off
    expect(layer.state.get()).toEqual({ kind: 'open', handedOff: true });
  });

  it('As a sheet closed inside a hand-off, I stay up until it is settled and then close handed off', () => {
    // Given an open sheet, and a hand-off that holds a sheet that closes
    const { handOff, layer } = setup();
    layer.update({ kind: 'opened' });
    handOff.holding = true;

    // When the sheet closes, and the hand-off then settles taken
    layer.update({ kind: 'closed' });
    const whileHeld = layer.state.get().kind;
    handOff.settles[0]?.(true);

    // Then it stayed up while held, and closed handed off
    expect(whileHeld).toBe('held');
    expect(layer.state.get()).toEqual({ kind: 'closed', handedOff: true });
  });

  it('As a sheet reopened while held, I stay open when the old hand-off settles', () => {
    // Given a sheet closed inside a hand-off, then reopened outside one
    const { handOff, layer } = setup();
    layer.update({ kind: 'opened' });
    handOff.holding = true;
    layer.update({ kind: 'closed' });
    layer.update({ kind: 'opened' });

    // When the old hand-off settles taken
    handOff.settles[0]?.(true);

    // Then the sheet stays open, not handed off
    expect(layer.state.get()).toEqual({ kind: 'open', handedOff: false });
  });

  it('As a sheet held twice, I ignore the settle of the first hold', () => {
    // Given a sheet closed inside a hand-off, reopened, and closed inside a hand-off again
    const { handOff, layer } = setup();
    handOff.holding = true;
    layer.update({ kind: 'opened' });
    layer.update({ kind: 'closed' });
    layer.update({ kind: 'opened' });
    layer.update({ kind: 'closed' });
    const secondHeld = layer.state.get();

    // When the first hand-off settles taken
    handOff.settles[0]?.(true);

    // Then the sheet is still held by the second
    expect(layer.state.get()).toBe(secondHeld);
  });

  it('As a sheet closed outside a hand-off, I close at once', () => {
    // Given an open sheet, and no hand-off running
    const { layer } = setup();
    layer.update({ kind: 'opened' });

    // When the sheet closes
    layer.update({ kind: 'closed' });

    // Then it is closed, not handed off
    expect(layer.state.get()).toEqual({ kind: 'closed', handedOff: false });
  });

  it('As a sheet whose hand-off throws as I open, I stay closed and the throw is reported', () => {
    // Given a hand-off whose take throws
    const reports = recordReports({ onFinished: onTestFinished });
    const { handOff, layer } = setup();
    handOff.take = () => {
      throw new Error('take failed');
    };

    // When the sheet opens
    layer.update({ kind: 'opened' });

    // Then the throw is reported as a transition defect, and the layer is still closed
    expect(reports.exceptions).toMatchObject([{ step: 'transition' }]);
    expect(layer.state.get()).toEqual({ kind: 'closed', handedOff: false });
  });
});

function setup() {
  const handOff = {
    taking: false,
    holding: false,
    settles: [] as ((taken: boolean) => void)[],
    take(): boolean {
      return handOff.taking;
    },
    hold(settle: (taken: boolean) => void): boolean {
      handOff.settles.push(settle);
      return handOff.holding;
    },
  };
  return { handOff, layer: createSheetLayer({ handOff }) };
}
