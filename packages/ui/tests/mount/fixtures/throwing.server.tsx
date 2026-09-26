// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Server entries whose components throw at different depths, and one that
// renders cleanly, for render-hydratable.test.ts.

import { renderHydratableToString } from "@dotli/ui/mount/render-hydratable";
import { Island } from "@dotli/ui/components/shell/Island";
import type { JSX } from "@solidjs/web";

function Broken(): never {
  throw new Error("the shell is broken: missing store default");
}

function BrokenChild(): never {
  throw new Error("a child is broken: missing store default");
}

/** The root component itself throws. */
export function renderBroken(): string {
  return renderHydratableToString(() => <Broken />, "broken");
}

/** Renders its children, which Solid evaluates lazily. */
function Frame(props: { children: JSX.Element }) {
  return <section>{props.children}</section>;
}

/**
 * A child component throws below the root's own body (passed as children,
 * so it runs after the root returns), with no boundary of its own.
 */
export function renderBrokenChild(): string {
  return renderHydratableToString(
    () => (
      <div id="bar">
        <span>before</span>
        <Frame>
          <BrokenChild />
        </Frame>
      </div>
    ),
    "broken-child",
  );
}

/** An island's child throws, inside the island's own boundary. */
export function renderBrokenIsland(): string {
  return renderHydratableToString(
    () => (
      <div id="bar">
        <span>before</span>
        <Island name="broken">
          <BrokenChild />
        </Island>
        <span>after</span>
      </div>
    ),
    "broken-island",
  );
}

function Fine() {
  return <span>fine</span>;
}

/** Nothing throws: a static root with a child component and an island. */
export function renderClean(): string {
  return renderHydratableToString(
    () => (
      <div id="bar">
        <Fine />
        <Island name="fine">
          <Fine />
        </Island>
      </div>
    ),
    "clean",
  );
}
