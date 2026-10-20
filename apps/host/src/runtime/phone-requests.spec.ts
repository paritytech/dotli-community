// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { encodeWireMessage, MESSAGE_TYPE_REQUEST } from '@parity/truapi';
import { ACCOUNT_REQUEST_LOGIN } from '@parity/truapi/wire-table';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { spans as S } from '@dotli/metrics';
import { bindRecordingSentry, recordCaptures } from '@dotli/metrics/testing';
import { recordLog } from '@dotli/shared/testing';
import { garbageRequestFrame, requestFrame, responseFrame } from './phone-requests.fake.js';
import { createPhoneRequestTracker, type PhoneRequest } from './phone-requests.js';

const SIGNATURE = { signature: '0x01' };
const REJECTED = { domain: { tag: 'Rejected' } };

function signRawBody(label: string): unknown {
  return {
    account: { dotNsIdentifier: 'product.dot', derivationIndex: { tag: 'Index', value: 0 } },
    payload: { tag: 'Payload', value: { payload: label } },
  };
}

function signPayloadBody(): unknown {
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

const isSignRaw = (request: PhoneRequest): boolean => request.method === 'signRaw';

function tracker() {
  const reportUndecodable = vi.fn();
  return { tracker: createPhoneRequestTracker({ reportUndecodable }), reportUndecodable };
}

describe('phone request tracker', () => {
  it('As a host, I claim an in-flight sign request and hear it was signed', async () => {
    // Given
    const { tracker: requests } = tracker();
    const tap = requests.connect();
    tap.fromProduct(requestFrame('a', 'signPayload', signPayloadBody()));

    // When
    const claim = requests.claim(request => request.method === 'signPayload');
    tap.fromCore(responseFrame('a', 'signPayload', { ok: SIGNATURE }));

    // Then
    expect(claim?.request.body).toEqual(signPayloadBody());
    expect(claim?.request.bytes.length).toBeGreaterThan(0);
    await expect(claim?.ended).resolves.toEqual({ kind: 'ok', method: 'signPayload' });
  });

  it('As a host, I claim a request and hear it was rejected on the phone', async () => {
    // Given
    const { tracker: requests } = tracker();
    const tap = requests.connect();
    tap.fromProduct(requestFrame('a', 'signRaw', signRawBody('x')));
    const claim = requests.claim(isSignRaw);

    // When
    tap.fromCore(responseFrame('a', 'signRaw', REJECTED));

    // Then
    await expect(claim?.ended).resolves.toEqual({ kind: 'rejected' });
  });

  it('As a host, I claim two identical requests one each', async () => {
    // Given
    const { tracker: requests } = tracker();
    const tap = requests.connect();
    tap.fromProduct(requestFrame('a', 'signRaw', signRawBody('same')));
    tap.fromProduct(requestFrame('b', 'signRaw', signRawBody('same')));

    // When
    const first = requests.claim(isSignRaw);
    const second = requests.claim(isSignRaw);
    const third = requests.claim(isSignRaw);
    tap.fromCore(responseFrame('b', 'signRaw', REJECTED));
    tap.fromCore(responseFrame('a', 'signRaw', { ok: SIGNATURE }));

    // Then
    expect(third).toBeUndefined();
    await expect(first?.ended).resolves.toEqual({ kind: 'ok', method: 'signRaw' });
    await expect(second?.ended).resolves.toEqual({ kind: 'rejected' });
  });

  it('As a host, I find no claim for a request that already has its response', () => {
    // Given
    const { tracker: requests } = tracker();
    const tap = requests.connect();
    tap.fromProduct(requestFrame('a', 'signRaw', signRawBody('x')));
    tap.fromCore(responseFrame('a', 'signRaw', { ok: SIGNATURE }));

    // When
    const claim = requests.claim(isSignRaw);

    // Then
    expect(claim).toBeUndefined();
  });

  it('As a host, I keep waiting when a response is for another request id', async () => {
    // Given
    const { tracker: requests } = tracker();
    const tap = requests.connect();
    tap.fromProduct(requestFrame('a', 'signRaw', signRawBody('x')));
    const claim = requests.claim(isSignRaw);
    let settled = false;
    void claim?.ended.then(() => {
      settled = true;
    });

    // When
    tap.fromCore(responseFrame('other', 'signRaw', { ok: SIGNATURE }));
    await Promise.resolve();

    // Then
    expect(settled).toBe(false);

    // When
    tap.fromCore(responseFrame('a', 'signRaw', { ok: SIGNATURE }));

    // Then
    await expect(claim?.ended).resolves.toEqual({ kind: 'ok', method: 'signRaw' });
  });

  it('As a host, I keep the request ids of two connections apart', async () => {
    // Given
    const { tracker: requests } = tracker();
    const one = requests.connect();
    const two = requests.connect();
    one.fromProduct(requestFrame('1', 'signRaw', signRawBody('one')));
    two.fromProduct(requestFrame('1', 'signRaw', signRawBody('two')));
    const first = requests.claim(isSignRaw);
    const second = requests.claim(isSignRaw);

    // When
    two.fromCore(responseFrame('1', 'signRaw', REJECTED));
    one.fromCore(responseFrame('1', 'signRaw', { ok: SIGNATURE }));

    // Then
    expect(first?.request.body).toEqual(signRawBody('one'));
    await expect(first?.ended).resolves.toEqual({ kind: 'ok', method: 'signRaw' });
    await expect(second?.ended).resolves.toEqual({ kind: 'rejected' });
  });

  it('As a host, I close a tap and hear its claims end as gone', async () => {
    // Given
    const { tracker: requests } = tracker();
    const tap = requests.connect();
    tap.fromProduct(requestFrame('a', 'signRaw', signRawBody('claimed')));
    tap.fromProduct(requestFrame('b', 'signRaw', signRawBody('unclaimed')));
    const claim = requests.claim(isSignRaw);

    // When
    tap.close();
    tap.close();

    // Then
    await expect(claim?.ended).resolves.toEqual({ kind: 'gone' });
    expect(requests.claim(isSignRaw)).toBeUndefined();
  });

  it('As a host, I send a request on a closed tap and find nothing to claim', () => {
    // Given
    const { tracker: requests, reportUndecodable } = tracker();
    const tap = requests.connect();
    tap.close();

    // When
    tap.fromProduct(requestFrame('a', 'signRaw', signRawBody('late')));
    tap.fromProduct(garbageRequestFrame('b', 'signRaw'));

    // Then
    expect(requests.claim(isSignRaw)).toBeUndefined();
    expect(reportUndecodable).not.toHaveBeenCalled();
  });

  it('As a host, I dispose the tracker and hear every claim end as gone', async () => {
    // Given
    const { tracker: requests } = tracker();
    const one = requests.connect();
    const two = requests.connect();
    one.fromProduct(requestFrame('a', 'signRaw', signRawBody('x')));
    two.fromProduct(requestFrame('a', 'signRaw', signRawBody('y')));
    const first = requests.claim(isSignRaw);
    const second = requests.claim(isSignRaw);

    // When
    requests.dispose();
    requests.dispose();

    // Then
    await expect(first?.ended).resolves.toEqual({ kind: 'gone' });
    await expect(second?.ended).resolves.toEqual({ kind: 'gone' });
  });

  it('As a host, I report an undecodable request and find nothing to claim', () => {
    // Given
    const { tracker: requests, reportUndecodable } = tracker();
    const tap = requests.connect();

    // When
    tap.fromProduct(garbageRequestFrame('a', 'signPayload'));

    // Then
    expect(requests.claim(() => true)).toBeUndefined();
    expect(reportUndecodable).toHaveBeenCalledOnce();
    expect(reportUndecodable.mock.calls[0]?.[0]).toBe('signPayload');
  });

  it('As a host, I report an undecodable answer and hear the claim end as failed', async () => {
    // Given
    const { tracker: requests, reportUndecodable } = tracker();
    const tap = requests.connect();
    tap.fromProduct(requestFrame('a', 'signRaw', signRawBody('x')));
    const claim = requests.claim(isSignRaw);
    const answer = responseFrame('a', 'signRaw', { ok: SIGNATURE });

    // When
    tap.fromCore(answer.subarray(0, answer.length - 3));

    // Then
    await expect(claim?.ended).resolves.toEqual({ kind: 'failed', tag: 'undecodable', reason: 'undecodable' });
    expect(reportUndecodable).toHaveBeenCalledOnce();
    expect(reportUndecodable.mock.calls[0]?.[0]).toBe('signRaw');
    expect(reportUndecodable.mock.calls[0]?.[2]).toBe('response');
  });

  it('As a host, I count an undecodable request once as undecodable and report it', () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const captured = recordCaptures({ onFinished: onTestFinished });
    const logged = recordLog({ onFinished: onTestFinished, level: 'error' });
    const requests = createPhoneRequestTracker();
    const tap = requests.connect();

    // When
    tap.fromProduct(garbageRequestFrame('a', 'signPayload'));

    // Then
    expect(sentry.counted(S.PHONE_REQUEST)).toEqual([{ outcome: 'undecodable', reason: 'signPayload' }]);
    expect(captured).toEqual([{ flow: 'wallet', step: 'phone_request', tags: { method: 'signPayload' } }]);
    expect(logged).toHaveLength(1);
  });

  it('As a host, I report an undecodable answer and leave its count to the claim', async () => {
    // Given
    const sentry = bindRecordingSentry({ onFinished: onTestFinished });
    const captured = recordCaptures({ onFinished: onTestFinished });
    const logged = recordLog({ onFinished: onTestFinished, level: 'error' });
    const requests = createPhoneRequestTracker();
    const tap = requests.connect();
    tap.fromProduct(requestFrame('a', 'signRaw', signRawBody('x')));
    const claim = requests.claim(isSignRaw);
    const answer = responseFrame('a', 'signRaw', { ok: SIGNATURE });

    // When
    tap.fromCore(answer.subarray(0, answer.length - 3));

    // Then
    await expect(claim?.ended).resolves.toMatchObject({ kind: 'failed', tag: 'undecodable' });
    expect(sentry.counted(S.PHONE_REQUEST)).toEqual([]);
    expect(captured).toEqual([{ flow: 'wallet', step: 'phone_request', tags: { method: 'signRaw' } }]);
    expect(logged).toHaveLength(1);
  });

  it('As a host, a response on a closed tap settles nothing', async () => {
    // Given
    const { tracker: requests } = tracker();
    const tap = requests.connect();
    tap.fromProduct(requestFrame('a', 'signRaw', signRawBody('x')));
    const claim = requests.claim(isSignRaw);
    tap.close();

    // When
    tap.fromCore(responseFrame('a', 'signRaw', { ok: SIGNATURE }));

    // Then
    await expect(claim?.ended).resolves.toEqual({ kind: 'gone' });
  });

  it('As a host, I ignore frames of other methods and find nothing to claim', () => {
    // Given
    const { tracker: requests, reportUndecodable } = tracker();
    const tap = requests.connect();
    const other = encodeWireMessage({
      requestId: 'a',
      payload: {
        traitId: ACCOUNT_REQUEST_LOGIN.trait,
        methodId: ACCOUNT_REQUEST_LOGIN.method,
        messageType: MESSAGE_TYPE_REQUEST,
        value: new Uint8Array([1, 2, 3]),
      },
    });
    if (other.isErr()) {
      throw other.error;
    }

    // When
    tap.fromProduct(other.value);
    tap.fromProduct(new Uint8Array([0xff]));

    // Then
    expect(requests.claim(() => true)).toBeUndefined();
    expect(reportUndecodable).not.toHaveBeenCalled();
  });
});
