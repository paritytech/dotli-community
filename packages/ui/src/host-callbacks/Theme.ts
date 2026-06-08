import type { HostCallbacks } from "@parity/truapi-host-wasm";
import type { Theme } from "@parity/truapi";
import { createResultStream } from "./result-stream";

function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "Light"
    : "Dark";
}

export function createThemeSubscribe(): HostCallbacks["subscribeTheme"] {
  return () =>
    createResultStream<Theme>([currentTheme()], (push) => {
      const onThemeChanged = (): void => {
        push(currentTheme());
      };
      window.addEventListener("dotli:theme-changed", onThemeChanged);
      return () => {
        window.removeEventListener("dotli:theme-changed", onThemeChanged);
      };
    });
}
