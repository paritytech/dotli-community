import { chromium } from "@playwright/test";

async function journey(name, warmCtx) {
  const b = warmCtx?.browser ?? (await chromium.launch());
  const ctx = warmCtx?.ctx ?? (await b.newContext());
  if (!warmCtx) {
    await ctx.addInitScript(() => localStorage.setItem("dotli:chain-backend", "smoldot-direct"));
  }
  const p = await ctx.newPage();
  const envelopes = [];
  p.on("request", (r) => {
    if (r.url().endsWith("/t") && r.method() === "POST") {
      envelopes.push({ body: r.postData() ?? "", status: null, req: r });
    }
  });
  p.on("response", (resp) => {
    if (resp.url().endsWith("/t")) {
      const e = envelopes.find((x) => x.req === resp.request());
      if (e) e.status = resp.status();
    }
  });
  const t0 = Date.now();
  await p.goto("https://host-playground.westend.li/", { waitUntil: "commit" });
  await p.locator("#chains-button.visible").waitFor({ timeout: 180000 });
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  // Give the transaction envelope time to flush after render.
  await p.waitForTimeout(8000);
  // Navigate away to fire pagehide-driven flushes too.
  await p.goto("about:blank");
  await p.waitForTimeout(1500);

  const resolutions = [];
  for (const e of envelopes) {
    if (!e.body) continue;
    for (const line of e.body.split("\n")) {
      if (!line.includes('"transaction"') && !line.includes("dotli.resolution")) continue;
      try {
        const j = JSON.parse(line);
        const tags = j.tags ?? {};
        const data = j.contexts?.trace?.data ?? {};
        if ((j.transaction ?? "").includes("resolution") || tags["dotli.resolution_id"] || data["dotli.resolution_id"]) {
          resolutions.push({
            transaction: j.transaction,
            rid: tags["dotli.resolution_id"] ?? data["dotli.resolution_id"] ?? null,
            outcome: data.outcome ?? j.extra?.outcome ?? null,
            cid_cache: data.cid_cache ?? null,
            status: e.status,
          });
        }
      } catch { /* not JSON */ }
    }
  }
  console.log(`=== ${name}: rendered in ${dur}s, ${envelopes.length} /t posts, statuses: ${[...new Set(envelopes.map((e) => e.status))].join(",")}`);
  for (const r of resolutions) console.log(JSON.stringify(r));
  await p.close();
  return { b, ctx };
}

const cold = await journey("cold smoldot-direct", null);
await journey("warm revisit", cold);
await cold.b.close();
