// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Server half of a hydrated root: renders `view` the way hydrateRoot
// (mount/root.ts) hydrates it. Server-only; imported by server entries such
// as components/shell/shell.server.tsx, never by client code.

import { renderToString, type JSX } from "@solidjs/web";
import { withHydrationBoundary } from "./hydration-boundary";

/**
 * Server-renders `view` inside {@link withHydrationBoundary}, the boundary
 * hydrateRoot hydrates inside (the keys must line up), and throws on any
 * render error, so a build-time prerender fails loudly instead of shipping a
 * broken shell.
 *
 * Solid throws out of `renderToString` only for an error raised in the root
 * component's own body. An error raised deeper (a child component, an
 * island, whatever boundary it is under) is contained: the boundary renders
 * its fallback, the error is serialized into a `<script>` for the client, and
 * the render returns normally. Every such error passes through the `onError`
 * policy, so it is collected there and the first one is rethrown after the
 * render. Any `<script>` left in the output fails too: the prerender is a
 * bare fragment with no hydration or serialization script (nothing would
 * run it), so a script means server state the client would never get.
 *
 * The rethrown error names `renderId` and has the original error as its
 * `cause`. The policy also keeps Solid's production server build from
 * replacing errors with a sanitized `Error("Internal Server Error")` (meant
 * for responses a visitor sees), which would leave a failed build with no
 * cause.
 */
export function renderHydratableToString(
  view: () => JSX.Element,
  renderId: string,
): string {
  const contained: unknown[] = [];
  const html = renderToString(
    () =>
      withHydrationBoundary(view, (err) => {
        throw err;
      }),
    {
      renderId,
      onError: (err: unknown) => {
        contained.push(err);
        return err;
      },
    },
  );
  if (contained.length > 0) {
    const [first] = contained;
    const text = first instanceof Error ? first.message : String(first);
    throw new Error(
      `[render-hydratable] render "${renderId}" hit ${String(contained.length)} error(s) below its root component, which Solid contained instead of throwing; first: ${text}`,
      { cause: first },
    );
  }
  if (html.includes("<script")) {
    throw new Error(
      `[render-hydratable] render "${renderId}" produced a <script> (serialized server state or a contained error); a prerendered fragment has nothing to run it: ${html.slice(html.indexOf("<script"), html.indexOf("<script") + 300)}`,
    );
  }
  return html;
}
