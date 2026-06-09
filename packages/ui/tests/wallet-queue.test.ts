// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { errAsync, okAsync } from "neverthrow";
import { createWalletFlowQueue } from "@dotli/ui/wallet-queue";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createWalletFlowQueue", () => {
  it("preserves call order even when later thunks resolve faster", async () => {
    const queue = createWalletFlowQueue();
    const order: string[] = [];

    const first = queue<string, never>(() =>
      okAsync(undefined).map(async () => {
        await wait(30);
        order.push("first");
        return "first";
      }),
    );
    const second = queue<string, never>(() =>
      okAsync(undefined).map(() => {
        order.push("second");
        return "second";
      }),
    );

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.isOk() && r1.value).toBe("first");
    expect(r2.isOk() && r2.value).toBe("second");
    expect(order).toEqual(["first", "second"]);
  });

  it("does not break the chain when a thunk returns errAsync", async () => {
    const queue = createWalletFlowQueue();
    const order: string[] = [];

    const failing = queue<string, string>(() => {
      order.push("failing");
      return errAsync("boom");
    });
    const followUp = queue<string, never>(() => {
      order.push("followUp");
      return okAsync("ok");
    });

    const r1 = await failing;
    const r2 = await followUp;

    expect(r1.isErr() && r1.error).toBe("boom");
    expect(r2.isOk() && r2.value).toBe("ok");
    expect(order).toEqual(["failing", "followUp"]);
  });

  it("surfaces the original error type to the caller", async () => {
    const queue = createWalletFlowQueue();
    type MyErr = { kind: "my-err"; reason: string };
    const myErr: MyErr = { kind: "my-err", reason: "nope" };

    const r = await queue<never, MyErr>(() => errAsync(myErr));
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error).toEqual(myErr);
    }
  });

  it("serializes many concurrent calls in FIFO order", async () => {
    const queue = createWalletFlowQueue();
    const order: number[] = [];

    const tasks = Array.from({ length: 5 }, (_, i) =>
      queue<number, never>(() =>
        okAsync(undefined).map(async () => {
          // Earlier tasks wait longer so a non-serialized impl would reorder.
          await wait(20 - i * 3);
          order.push(i);
          return i;
        }),
      ),
    );

    const results = await Promise.all(tasks);
    expect(results.map((r) => r.isOk() && r.value)).toEqual([0, 1, 2, 3, 4]);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("isolates state across queue instances", async () => {
    const a = createWalletFlowQueue();
    const b = createWalletFlowQueue();
    const order: string[] = [];

    const slowOnA = a<string, never>(() =>
      okAsync(undefined).map(async () => {
        await wait(20);
        order.push("a");
        return "a";
      }),
    );
    const fastOnB = b<string, never>(() =>
      okAsync(undefined).map(() => {
        order.push("b");
        return "b";
      }),
    );

    await Promise.all([slowOnA, fastOnB]);
    // Independent queues, so fast B finishes before slow A despite later call.
    expect(order).toEqual(["b", "a"]);
  });
});
