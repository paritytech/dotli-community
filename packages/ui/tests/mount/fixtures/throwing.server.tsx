// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Server entries whose components throw at different depths, and one that
// renders cleanly, for render-hydratable.test.ts.

import { Errored } from "solid-js";
import { renderHydratableToString } from "@dotli/ui/mount/render-hydratable";
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

/**
 * Wraps its children in an error boundary of its own that renders nothing,
 * so an error below it never reaches the render's root boundary.
 */
function Contained(props: { children: JSX.Element }) {
  return <Errored fallback={() => null}>{props.children}</Errored>;
}

/** A nested child throws, inside a boundary of its own. */
export function renderBrokenInBoundary(): string {
  return renderHydratableToString(
    () => (
      <div id="bar">
        <span>before</span>
        <Contained>
          <Frame>
            <BrokenChild />
          </Frame>
        </Contained>
        <span>after</span>
      </div>
    ),
    "broken-in-boundary",
  );
}

function Fine() {
  return <span>fine</span>;
}

/**
 * Nothing throws: a static root with a child component and a nested one
 * inside a boundary.
 */
export function renderClean(): string {
  return renderHydratableToString(
    () => (
      <div id="bar">
        <Fine />
        <Contained>
          <Frame>
            <Fine />
          </Frame>
        </Contained>
      </div>
    ),
    "clean",
  );
}
