import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const config = resolve(root, "dist/server/wrangler.json");
const rootVars = resolve(root, ".dev.vars");

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

if (!existsSync(resolve(root, "node_modules/vinext"))) {
  throw new Error("请先运行 npm ci 安装依赖。");
}
if (!existsSync(rootVars)) {
  const seal = randomBytes(32).toString("base64url");
  writeFileSync(rootVars, `TEACHER_CREDENTIAL_SEAL=${seal}\n`, { mode: 0o600 });
  console.log("已生成只供本机使用的密钥。");
}

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("请使用 npm run local:setup 启动配置。");
run([npmCli, "run", "build"]);

const built = JSON.parse(readFileSync(config, "utf8"));
if (!built.d1_databases?.some((database) => database.binding === "DB")) {
  throw new Error("构建结果缺少本地数据库绑定 DB。");
}
mkdirSync(resolve(root, "dist/server"), { recursive: true });
copyFileSync(rootVars, resolve(root, "dist/server/.dev.vars"));
run([
  resolve(root, "node_modules/wrangler/bin/wrangler.js"),
  "d1", "execute", "DB", "--local", "--config", config,
  "--persist-to", resolve(root, ".wrangler/state"),
  "--file", resolve(root, "db/cloud-archive.sql"),
]);
console.log("本地版已准备好。运行 npm run local，打开显示的本机网址。");
