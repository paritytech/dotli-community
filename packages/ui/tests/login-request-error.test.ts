import { describe, expect, it } from "vitest";
import { LoginRequestError } from "@dotli/ui/login-request-error";

describe("LoginRequestError", () => {
  it("classifies a user-rejected login", () => {
    const error = new LoginRequestError({
      tag: "V1",
      value: { tag: "Unknown", value: { reason: "Rejected" } },
    });

    expect(error.rejected).toBe(true);
    expect(error).toBeInstanceOf(Error);
  });

  it("keeps other login failures unclassified", () => {
    const error = new LoginRequestError({
      tag: "V1",
      value: { tag: "Unknown", value: { reason: "Host failure: boom" } },
    });

    expect(error.rejected).toBe(false);
    expect(error.message).toBe(
      JSON.stringify({
        tag: "V1",
        value: { tag: "Unknown", value: { reason: "Host failure: boom" } },
      }),
    );
  });

  it("does not throw for malformed error envelopes", () => {
    const error = new LoginRequestError({
      tag: "V1",
      value: "Rejected",
    } as never);

    expect(error.rejected).toBe(false);
  });

  it("does not throw when the versioned error value is missing", () => {
    const error = new LoginRequestError({
      tag: "V1",
    } as never);

    expect(error.rejected).toBe(false);
  });

  it("does not throw when the domain error value is missing", () => {
    const error = new LoginRequestError({
      tag: "V1",
      value: { tag: "Unknown" },
    } as never);

    expect(error.rejected).toBe(false);
  });
});
