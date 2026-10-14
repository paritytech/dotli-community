# `@config/astro-solid`

An Astro integration for Solid 2. It renders Solid components on the server and hydrates or renders them in islands on
the client.

## Responsibility

- The Astro renderer (client and server entrypoints) and the integration that adds it.
- Handing the client build's asset manifest to server renders, so `lazy()` boundaries inside islands resolve.
- Not owned: the components and islands themselves, which live in the apps and UI packages.

## Design

- At `astro:config:setup` the integration adds the renderer and the Solid Vite plugin with SSR on. It marks Solid
  libraries (found by their peer dependencies) as `noExternal` so Node never loads their browser-only build.
- It defines the virtual module `virtual:astro-solid-manifest`. In dev it returns the Solid plugin's live manifest. In a
  build it reads the client manifest from an in-process registry the client build fills, since prerendering runs in the
  same process.
- The server entrypoint renders a component to a stream, with hydration markers unless the island has no directive. A
  probe pass checks whether a component renders, once per component type.
- The client entrypoint hydrates, or renders for `client:only`, and keeps props in a signal so a re-render updates the
  island. It disposes on `astro:unmount`.
- Node loads the integration directly from the Astro config, so it is plain TypeScript with no build step.

## Entries

| Entry                           | Use                                                                       |
| ------------------------------- | ------------------------------------------------------------------------- |
| `@config/astro-solid`           | Default export `astroSolid(options)`, the integration for `astro.config`. |
| `@config/astro-solid/client.js` | The client entrypoint Astro loads for islands.                            |
| `@config/astro-solid/server.js` | The server entrypoint Astro loads for rendering.                          |

The host app adds the integration to its Astro config.
