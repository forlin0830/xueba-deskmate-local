import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "本地数据库不可用。请先运行 npm run local:setup，再运行 npm run local。"
    );
  }

  return drizzle(env.DB, { schema });
}
