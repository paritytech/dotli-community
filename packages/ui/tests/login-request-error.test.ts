import { describe, expect, it } from "vitest";
import {
  LoginRequestError,
  isLoginCancellation,
} from "@dotli/ui/login-request-error";

describe("LoginRequestError", () => {
  it("classifies a user-rejected login", () => {
    const error = new LoginRequestError({
      tag: "V1",
      value: { tag: "Unknown", value: { reason: "Rejected" } },
    });

    expect(error.rejected).toBe(true);
    expect(isLoginCancellation(error)).toBe(true);
    expect(error).toBeInstanceOf(Error);
  });

  it("classifies plain rejected values from cancellation paths", () => {
    expect(isLoginCancellation("Rejected")).toBe(true);
    expect(isLoginCancellation(new Error("Rejected"))).toBe(true);
    expect(isLoginCancellation('"Rejected"')).toBe(true);
    expect(isLoginCancellation(new Error('"Rejected"'))).toBe(true);
  });

  it("classifies rejected values inside malformed envelopes", () => {
    const error = new LoginRequestError({
      tag: "V1",
      value: { tag: "Unknown", value: "Rejected" },
    } as never);

    expect(error.rejected).toBe(true);
    expect(isLoginCancellation(error)).toBe(true);
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

  it("classifies malformed rejected envelopes as cancellation", () => {
    const error = new LoginRequestError({
      tag: "V1",
      value: "Rejected",
    } as never);

    expect(error.rejected).toBe(true);
    expect(isLoginCancellation(error)).toBe(true);
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
