import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";

export interface WikiConfig {
  wiki: { name: string };
  db9: { database: string; token: string };
  search: { top_k: number };
}

const CONFIG_FILE = "wiki9.toml";

export async function loadConfig(dir: string = process.cwd(), useEnvironmentToken = true): Promise<WikiConfig> {
  const path = join(dir, CONFIG_FILE);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: string;
  try {
    if (!(await file.stat()).isFile()) throw new Error("wiki9.toml must be a regular file");
    await file.chmod(0o600);
    raw = await file.readFile("utf-8");
  } finally {
    await file.close();
  }
  let parsed: WikiConfig;
  try {
    parsed = parse(raw) as unknown as WikiConfig;
  } catch {
    throw new Error("Invalid wiki9.toml: cannot parse TOML");
  }
  const topK = parsed.search?.top_k ?? 5;
  if (!Number.isSafeInteger(topK) || topK < 0) {
    throw new Error("search.top_k must be a non-negative safe integer");
  }
  const database = parsed.db9?.database;
  const environmentToken = useEnvironmentToken ? process.env.WIKI9_TOKEN : undefined;
  if (environmentToken !== undefined && !environmentToken.trim()) {
    throw new Error("WIKI9_TOKEN is empty; unset it to use configured or login credentials");
  }
  const token = environmentToken ?? parsed.db9?.token ?? "";
  if (typeof database !== "string" || !database.trim() || typeof token !== "string") {
    throw new Error("db9.database must be a non-empty string and db9.token must be a string");
  }
  return {
    wiki: { name: parsed.wiki?.name ?? "Wiki" },
    db9: {
      database,
      token,
    },
    search: { top_k: topK },
  };
}
