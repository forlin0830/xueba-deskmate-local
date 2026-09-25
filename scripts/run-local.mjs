import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const config = resolve(root, "dist/server/wrangler.json");
const rootVars = resolve(root, ".dev.vars");
if (!existsSync(config) || !existsSync(rootVars)) {
  throw new Error("请先运行 npm run local:setup。");
}
copyFileSync(rootVars, resolve(root, "dist/server/.dev.vars"));
const result = spawnSync(process.execPath, [
  resolve(root, "node_modules/wrangler/bin/wrangler.js"),
  "dev", "--config", config, "--local", "--persist-to", resolve(root, ".wrangler/state"),
  "--ip", "127.0.0.1", "--port", "8787", "--inspector-port", "0",
], { cwd: root, stdio: "inherit", env: { ...process.env, CLOUDFLARE_CF_FETCH_ENABLED: "false", WRANGLER_SEND_METRICS: "false" } });
if (result.error) throw result.error;
process.exit(result.status || 0);
