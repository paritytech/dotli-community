import type { ThemeHost } from "@parity/truapi-host";
import type { HostThemeSubscribeItem } from "@parity/truapi";
import { createResultStream } from "./result-stream";

function currentTheme(): HostThemeSubscribeItem {
  return {
    name: { tag: "Default" },
    variant:
      document.documentElement.getAttribute("data-theme") === "light"
        ? "Light"
        : "Dark",
  };
}

export function createThemeSubscribe(): Required<ThemeHost>["subscribeTheme"] {
  return () =>
    createResultStream<HostThemeSubscribeItem>([currentTheme()], (push) => {
      const onThemeChanged = (): void => {
        push(currentTheme());
      };
      window.addEventListener("dotli:theme-changed", onThemeChanged);
      return () => {
        window.removeEventListener("dotli:theme-changed", onThemeChanged);
      };
    });
}
