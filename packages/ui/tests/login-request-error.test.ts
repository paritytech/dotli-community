import { describe, expect, it } from "vitest";
import { LoginRequestError } from "@dotli/ui/login-request-error";

describe("LoginRequestError", () => {
  it("carries the versioned error and a JSON message", () => {
    const versioned = {
      tag: "V1",
      value: { tag: "Unknown", value: { reason: "Host failure: boom" } },
    } as const;
    const error = new LoginRequestError(versioned);

    expect(error).toBeInstanceOf(Error);
    expect(error.error).toEqual(versioned);
    expect(error.message).toBe(JSON.stringify(versioned));
  });
});
