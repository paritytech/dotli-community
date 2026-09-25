// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { fireEvent } from "@solidjs/testing-library";
import { SolidProbe } from "@dotli/ui/components/dev/SolidProbe";
import { renderComponent, settle } from "../helpers/solid";

describe("Solid toolchain probe", () => {
  it("As a dotli developer, a Solid component renders, reacts to a click, and toggles a Show branch", async () => {
    // Given
    const view = renderComponent(() => <SolidProbe label="Taps" />);
    const button = view.getByRole("button");
    expect(button.textContent).toBe("Taps: 0");
    expect(view.queryByText("Tapped")).toBeNull();

    // When
    fireEvent.click(button);
    await settle();

    // Then
    expect(button.textContent).toBe("Taps: 1");
    expect(button.classList.contains("solid-probe")).toBe(true);
    expect(view.getByText("Tapped")).toBeTruthy();
  });
});
