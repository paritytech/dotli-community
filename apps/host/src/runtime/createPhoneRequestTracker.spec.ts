// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { decodeWireMessage } from '@parity/truapi';
import { ACCOUNT_REQUEST_LOGIN } from '@parity/truapi/wire-table';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindRecordingSentry, recordReports } from '@dotli/metrics/testing';
import { recordLog } from '@dotli/shared/testing';
import { encodeGarbagePhoneRequestFrame } from '../testing/encodeGarbagePhoneRequestFrame.js';
import { encodePhoneRequestFrame } from '../testing/encodePhoneRequestFrame.js';
import { encodePhoneResponseFrame, type PhoneResult } from '../testing/encodePhoneResponseFrame.js';
import { encodeRequestFrame } from '../testing/encodeRequestFrame.js';
import { encodeResponseFrame } from '../testing/encodeResponseFrame.js';
import {
  createPhoneRequestTracker,
  type PhoneClaim,
  type PhoneRequest,
  type PhoneRequestTracker,
} from './createPhoneRequestTracker.js';

const SIGNED: PhoneResult = { kind: 'ok', value: { signature: '0x01' } };
const REJECTED: PhoneResult = { kind: 'domain', value: { tag: 'Rejected' } };
/** The body of a login frame, which the tracker never decodes. */
const LOGIN_VALUE = new Uint8Array([1, 2, 3]);

/** A tracker whose undecodable reports and decodes are spies, the decode passing through to the real one. */
function createTrackerHarness() {
  const reportUndecodable = vi.fn();
  const decode = vi.fn(decodeWireMessage);
  return { tracker: createPhoneRequestTracker({ reportUndecodable, decode }), reportUndecodable, decode };
}

/** A tracker whose network holds are counted, each release acting once as the real one does. */
function createHoldHarness() {
  const holds = { open: 0 };
  const holdNetwork = () => {
    let released = false;
    holds.open += 1;
    return () => {
      if (!released) {
        released = true;
        holds.open -= 1;
      }
    };
  };
  return { tracker: createPhoneRequestTracker({ holdNetwork }), holds };
}

function isSignRaw(request: PhoneRequest): boolean {
  return request.method === 'signRaw';
}

function buildSignRawBody(label: string): unknown {
  return {
    account: { dotNsIdentifier: 'product.dot', derivationIndex: { tag: 'Index', value: 0 } },
    payload: { tag: 'Payload', value: { payload: label } },
  };
}

function buildSignPayloadBody(): unknown {
  return {
    account: { dotNsIdentifier: 'product.dot', derivationIndex: { tag: 'Index', value: 0 } },
    payload: {
      blockHash: '0x01',
      blockNumber: '0x02',
      era: '0x03',
      genesisHash: '0x04',
      method: '0x05',
      nonce: '0x06',
      specVersion: '0x07',
      tip: '0x08',
      transactionVersion: '0x09',
      signedExtensions: [],
      version: 4,
    },
  };
}

/** A login request, a method that never goes to the phone. */
function encodeLoginRequestFrame(requestId: string): Uint8Array {
  return encodeRequestFrame({ requestId, method: ACCOUNT_REQUEST_LOGIN, value: LOGIN_VALUE });
}

/** A login response, a method that never goes to the phone. */
function encodeLoginResponseFrame(requestId: string): Uint8Array {
  return encodeResponseFrame({ requestId, method: ACCOUNT_REQUEST_LOGIN, value: LOGIN_VALUE });
}

describe('phone request tracker', () => {
  it('As a dotli integrator, I claim an in-flight sign request and hear it was signed', async () => {
    // Given
    const { tracker: requests } = createTrackerHarness();
    const tap = requests.connect();
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signPayload', body: buildSignPayloadBody() }));

    // When
    const claim = requests.claim(request => request.method === 'signPayload');
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'a', method: 'signPayload', result: SIGNED }));

    // Then
    expect(claim?.request).toEqual({ method: 'signPayload', body: buildSignPayloadBody() });
    await expect(claim?.ended).resolves.toEqual({ kind: 'ok', method: 'signPayload' });
  });

  it('As a dotli integrator, I claim two identical requests and get one each, with no third', async () => {
    // Given
    const { tracker: requests } = createTrackerHarness();
    const tap = requests.connect();
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('same') }));
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'b', method: 'signRaw', body: buildSignRawBody('same') }));

    // When
    const first = requests.claim(isSignRaw);
    const second = requests.claim(isSignRaw);
    const third = requests.claim(isSignRaw);
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'b', method: 'signRaw', result: REJECTED }));
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'a', method: 'signRaw', result: SIGNED }));

    // Then
    expect(third).toBeUndefined();
    await expect(first?.ended).resolves.toEqual({ kind: 'ok', method: 'signRaw' });
    await expect(second?.ended).resolves.toEqual({ kind: 'rejected' });
  });

  it('As a dotli integrator, I claim a request that already has its response and find no claim', () => {
    // Given
    const { tracker: requests } = createTrackerHarness();
    const tap = requests.connect();
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('x') }));
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'a', method: 'signRaw', result: SIGNED }));

    // When
    const claim = requests.claim(isSignRaw);

    // Then
    expect(claim).toBeUndefined();
  });

  it('As a dotli integrator, I hear a response for another request id and keep waiting until my own arrives', async () => {
    // Given a claimed sign request in flight
    const { tracker: requests } = createTrackerHarness();
    const tap = requests.connect();
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('x') }));
    const claim = requests.claim(isSignRaw);

    // When a rejection for another id arrives, then the request's own signature
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'other', method: 'signRaw', result: REJECTED }));
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'a', method: 'signRaw', result: SIGNED }));

    // Then the claim ended with its own answer, as a claim ends once and the other id's rejection did not end it
    await expect(claim?.ended).resolves.toEqual({ kind: 'ok', method: 'signRaw' });
  });

  it('As a dotli integrator, I track two connections that use the same request id and keep their requests apart', async () => {
    // Given
    const { tracker: requests } = createTrackerHarness();
    const one = requests.connect();
    const two = requests.connect();
    one.fromProduct(encodePhoneRequestFrame({ requestId: '1', method: 'signRaw', body: buildSignRawBody('one') }));
    two.fromProduct(encodePhoneRequestFrame({ requestId: '1', method: 'signRaw', body: buildSignRawBody('two') }));
    const first = requests.claim(isSignRaw);
    const second = requests.claim(isSignRaw);

    // When
    two.fromCore(encodePhoneResponseFrame({ requestId: '1', method: 'signRaw', result: REJECTED }));
    one.fromCore(encodePhoneResponseFrame({ requestId: '1', method: 'signRaw', result: SIGNED }));

    // Then
    expect(first?.request.body).toEqual(buildSignRawBody('one'));
    await expect(first?.ended).resolves.toEqual({ kind: 'ok', method: 'signRaw' });
    await expect(second?.ended).resolves.toEqual({ kind: 'rejected' });
  });

  it('As a dotli integrator, I close a tap and hear its claims end as gone, with its unclaimed requests dropped', async () => {
    // Given
    const { tracker: requests } = createTrackerHarness();
    const tap = requests.connect();
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('claimed') }));
    tap.fromProduct(
      encodePhoneRequestFrame({ requestId: 'b', method: 'signRaw', body: buildSignRawBody('unclaimed') }),
    );
    const claim = requests.claim(isSignRaw);

    // When
    tap.dispose();
    tap.dispose();
    const afterClose = requests.claim(isSignRaw);

    // Then
    await expect(claim?.ended).resolves.toEqual({ kind: 'gone' });
    expect(afterClose).toBeUndefined();
  });

  it('As a dotli integrator, I claim from inside a tracker transition and my claim takes hold once that transition ends', async () => {
    // Given a network hold that claims while the second request is tracked
    let reentrant: PhoneClaim | undefined;
    let holds = 0;
    const tracker: PhoneRequestTracker = createPhoneRequestTracker({
      holdNetwork() {
        holds += 1;
        if (holds === 2) {
          reentrant = tracker.claim(isSignRaw);
        }
        return () => {};
      },
    });
    const tap = tracker.connect();
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('x') }));

    // When
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'b', method: 'signRaw', body: buildSignRawBody('y') }));
    const claim = tracker.claim(isSignRaw);
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'a', method: 'signRaw', result: SIGNED }));

    // Then the claim made inside took the oldest request, and the one after took the next
    expect(reentrant?.request.body).toEqual(buildSignRawBody('x'));
    expect(claim?.request.body).toEqual(buildSignRawBody('y'));
    await expect(reentrant?.ended).resolves.toEqual({ kind: 'ok', method: 'signRaw' });
  });

  it('As a dotli integrator, I claim one request twice from inside a tracker transition and the second claim ends as gone', async () => {
    // Given a network hold that claims twice while the second request is tracked
    const reentrant: (PhoneClaim | undefined)[] = [];
    let holds = 0;
    const tracker: PhoneRequestTracker = createPhoneRequestTracker({
      holdNetwork() {
        holds += 1;
        if (holds === 2) {
          reentrant.push(tracker.claim(isSignRaw), tracker.claim(isSignRaw));
        }
        return () => {};
      },
    });
    const tap = tracker.connect();
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('x') }));

    // When
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'b', method: 'signRaw', body: buildSignRawBody('y') }));

    // Then
    await expect(reentrant[1]?.ended).resolves.toEqual({ kind: 'gone' });
  });

  it('As a dotli integrator, I send a request on a closed tap and find nothing to claim', () => {
    // Given
    const { tracker: requests, reportUndecodable } = createTrackerHarness();
    const tap = requests.connect();
    tap.dispose();

    // When
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('late') }));
    tap.fromProduct(encodeGarbagePhoneRequestFrame('b', 'signRaw'));
    const claim = requests.claim(isSignRaw);

    // Then
    expect(claim).toBeUndefined();
    expect(reportUndecodable).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, I dispose the tracker and hear every claim end as gone', async () => {
    // Given
    const { tracker: requests } = createTrackerHarness();
    const one = requests.connect();
    const two = requests.connect();
    one.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('x') }));
    two.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('y') }));
    const first = requests.claim(isSignRaw);
    const second = requests.claim(isSignRaw);

    // When
    requests.dispose();
    requests.dispose();

    // Then
    await expect(first?.ended).resolves.toEqual({ kind: 'gone' });
    await expect(second?.ended).resolves.toEqual({ kind: 'gone' });
  });

  it('As a dotli integrator, I see an undecodable request reported and find nothing to claim', () => {
    // Given
    const { tracker: requests, reportUndecodable } = createTrackerHarness();
    const tap = requests.connect();

    // When
    tap.fromProduct(encodeGarbagePhoneRequestFrame('a', 'signPayload'));
    const claim = requests.claim(() => true);

    // Then
    expect(claim).toBeUndefined();
    expect(reportUndecodable.mock.calls).toEqual([
      [expect.objectContaining({ method: 'signPayload', leg: 'request' })],
    ]);
  });

  it('As an operator, I see an undecodable request counted once as undecodable and reported', () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const logged = recordLog({ onFinished: onTestFinished, level: 'error' });
    const requests = createPhoneRequestTracker();
    const tap = requests.connect();

    // When
    tap.fromProduct(encodeGarbagePhoneRequestFrame('a', 'signPayload'));

    // Then
    expect(sentry.counted('signing.phone_request')).toEqual([{ outcome: 'undecodable', reason: 'signPayload' }]);
    expect(captured).toMatchObject([{ step: 'phone_request', tags: { method: 'signPayload' } }]);
    expect(logged).toHaveLength(1);
  });

  it('As an operator, I see a transition fail because the undecodable report threw, and the tracker still tracks the next request', () => {
    // Given a tracker whose undecodable report throws
    const reports = recordReports({ onFinished: onTestFinished });
    const reportUndecodable = vi.fn(() => {
      throw new Error('report failed');
    });
    const requests = createPhoneRequestTracker({ reportUndecodable });
    const tap = requests.connect();

    // When an undecodable request is followed by a valid one
    tap.fromProduct(encodeGarbagePhoneRequestFrame('a', 'signRaw'));
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'b', method: 'signRaw', body: buildSignRawBody('x') }));
    const claim = requests.claim(isSignRaw);

    // Then the throw is reported as a defect of the tracker, and the valid request is claimable
    expect(reports.exceptions).toMatchObject([{ step: 'phone_tracker_transition' }]);
    expect(claim?.request.body).toEqual(buildSignRawBody('x'));
  });

  it('As an operator, I see an undecodable answer reported and its count left to the claim', async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const captured = recordReports({ onFinished: onTestFinished }).exceptions;
    const logged = recordLog({ onFinished: onTestFinished, level: 'error' });
    const requests = createPhoneRequestTracker();
    const tap = requests.connect();
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('x') }));
    const claim = requests.claim(isSignRaw);
    const answer = encodePhoneResponseFrame({ requestId: 'a', method: 'signRaw', result: SIGNED });

    // When
    tap.fromCore(answer.subarray(0, answer.length - 3));

    // Then
    await expect(claim?.ended).resolves.toEqual({ kind: 'undecodable' });
    expect(sentry.counted('signing.phone_request')).toEqual([]);
    expect(captured).toMatchObject([{ step: 'phone_request', tags: { method: 'signRaw' } }]);
    expect(logged).toHaveLength(1);
  });

  it('As a dotli integrator, I close a tap and a late answer leaves its claim ended as gone, not signed', async () => {
    // Given
    const { tracker: requests } = createTrackerHarness();
    const tap = requests.connect();
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('x') }));
    const claim = requests.claim(isSignRaw);
    tap.dispose();

    // When
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'a', method: 'signRaw', result: SIGNED }));

    // Then
    await expect(claim?.ended).resolves.toEqual({ kind: 'gone' });
  });

  it('As a dotli integrator, I relay frames of other methods and find nothing to claim', () => {
    // Given
    const { tracker: requests, reportUndecodable } = createTrackerHarness();
    const tap = requests.connect();

    // When
    tap.fromProduct(encodeLoginRequestFrame('a'));
    tap.fromProduct(new Uint8Array([0xff]));
    const claim = requests.claim(() => true);

    // Then
    expect(claim).toBeUndefined();
    expect(reportUndecodable).not.toHaveBeenCalled();
  });

  it('As a dotli integrator, I relay frames that are not tracked and only the tracked answer is decoded', async () => {
    // Given a sign request in flight, and frames of another method, another id and a request echoed back
    const { tracker: requests, decode } = createTrackerHarness();
    const tap = requests.connect();
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('x') }));
    const claim = requests.claim(isSignRaw);
    decode.mockClear();

    // When the untracked frames pass, then the tracked answer comes
    tap.fromProduct(encodeLoginRequestFrame('b'));
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('again') }));
    tap.fromCore(encodeLoginResponseFrame('b'));
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'other', method: 'signRaw', result: SIGNED }));
    tap.fromCore(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('x') }));
    const decodesBeforeAnswer = decode.mock.calls.length;
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'a', method: 'signRaw', result: SIGNED }));

    // Then none of them was decoded, and the answer is the one frame decoded
    expect(decodesBeforeAnswer).toBe(0);
    expect(decode).toHaveBeenCalledOnce();
    await expect(claim?.ended).resolves.toEqual({ kind: 'ok', method: 'signRaw' });
  });

  it("As a user asked to approve in Polkadot App, my page's network stays awake until the app answers", () => {
    // Given
    const { tracker: requests, holds } = createHoldHarness();
    const tap = requests.connect();

    // When
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('x') }));
    const heldWhileAsked = holds.open;
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'a', method: 'signRaw', result: SIGNED }));

    // Then
    expect(heldWhileAsked).toBe(1);
    expect(holds.open).toBe(0);
  });

  it("As a user with two requests to Polkadot App, my page's network stays held until both are answered", () => {
    // Given
    const { tracker: requests, holds } = createHoldHarness();
    const tap = requests.connect();
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('x') }));
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'b', method: 'signRaw', body: buildSignRawBody('y') }));

    // When
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'a', method: 'signRaw', result: SIGNED }));
    const heldAfterFirst = holds.open;
    tap.fromCore(encodePhoneResponseFrame({ requestId: 'b', method: 'signRaw', result: REJECTED }));

    // Then
    expect(heldAfterFirst).toBe(1);
    expect(holds.open).toBe(0);
  });

  it("As a user whose product went away mid-request, my page's hold is released", () => {
    // Given
    const { tracker: requests, holds } = createHoldHarness();
    const tap = requests.connect();
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('x') }));

    // When
    tap.dispose();

    // Then
    expect(holds.open).toBe(0);
  });

  it('As a page whose tracker is disposed mid-request, my hold is released', () => {
    // Given
    const { tracker: requests, holds } = createHoldHarness();
    const tap = requests.connect();
    tap.fromProduct(encodePhoneRequestFrame({ requestId: 'a', method: 'signRaw', body: buildSignRawBody('x') }));

    // When
    requests.dispose();

    // Then
    expect(holds.open).toBe(0);
  });
});
