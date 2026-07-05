import type { ThemeHost } from "@parity/truapi-host-wasm";
import type { ThemeVariant } from "@parity/truapi";
import { createResultStream } from "./result-stream";

function currentTheme(): ThemeVariant {
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "Light"
    : "Dark";
}

export function createThemeSubscribe(): Required<ThemeHost>["subscribeTheme"] {
  return () =>
    createResultStream<ThemeVariant>([currentTheme()], (push) => {
      const onThemeChanged = (): void => {
        push(currentTheme());
      };
      window.addEventListener("dotli:theme-changed", onThemeChanged);
      return () => {
        window.removeEventListener("dotli:theme-changed", onThemeChanged);
      };
    });
}
