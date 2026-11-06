import { constants } from "node:fs";
import { open, lstat, readlink, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { agentsMdTemplate } from "../templates/agents-md.js";
import { skillIngestTemplate } from "../templates/skill-ingest.js";
import { skillQueryTemplate } from "../templates/skill-query.js";
import { skillLintTemplate } from "../templates/skill-lint.js";
import { createClient, initSchema } from "../db.js";
import { loadConfig, type WikiConfig } from "../config.js";
import type { Db9Client } from "get-db9";
import { ensureSafeDirectory, isNotFound, readSafeFile, remoteChildPath, writeSafeFileIfMissing } from "../utils/paths.js";
import { displayText } from "../utils/output.js";
import { operationRecorder, type OperationRecorder } from "../utils/operations.js";

async function ensureDir(path: string) {
  await ensureSafeDirectory(process.cwd(), path, true, 0o700);
}

async function writeIfMissing(path: string, content: string, mode = 0o644) {
  const created = await writeSafeFileIfMissing(process.cwd(), path, content, mode);
  console.log(`  ${created ? "create" : "skip"} ${displayText(path)}${created ? "" : " (exists)"}`);
}

async function ensureSymlink(path: string, target: string) {
  try {
    const stat = await lstat(path);
    if (!stat.isSymbolicLink()) {
      console.log(`  skip ${path} (exists and is not a symlink)`);
      return;
    }

    const existingTarget = await readlink(path);
    if (existingTarget === target) {
      console.log(`  skip ${path} (symlink exists)`);
      return;
    }

    console.log(`  skip ${path} (points to ${existingTarget})`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await symlink(target, path, "dir");
    console.log(`  create ${path} -> ${target}`);
  }
}

async function writeBinaryIfMissing(path: string, content: Uint8Array) {
  const created = await writeSafeFileIfMissing(process.cwd(), path, content, 0o600);
  console.log(`  ${created ? "create" : "skip"} ${displayText(path)}${created ? "" : " (exists)"}`);
}

async function pullRemoteTree(client: Db9Client, dbId: string, dir: string, remotePath: string): Promise<number> {
  if (!(await client.fs.exists(dbId, remotePath))) {
    return 0;
  }

  let downloaded = 0;
  const entries = await client.fs.list(dbId, remotePath);
  for (const entry of entries) {
    const childRemotePath = remoteChildPath(remotePath, entry.path);
    if (entry.type === "dir") {
      await ensureDir(join(dir, childRemotePath.slice(1)));
      downloaded += await pullRemoteTree(client, dbId, dir, childRemotePath);
      continue;
    }
    if (entry.type !== "file") throw new Error("Cannot restore a remote special file");

    const localPath = join(dir, childRemotePath.replace(/^\//, ""));
    const content = await client.fs.readBinary(dbId, childRemotePath);
    await writeBinaryIfMissing(localPath, content);
    downloaded++;
  }

  return downloaded;
}

async function pullRemoteFile(client: Db9Client, dbId: string, dir: string, remotePath: string): Promise<boolean> {
  if (!(await client.fs.exists(dbId, remotePath))) {
    return false;
  }

  const localPath = join(dir, remotePath.replace(/^\//, ""));
  const content = await client.fs.readBinary(dbId, remotePath);
  await writeBinaryIfMissing(localPath, content);
  return true;
}

export async function initCommand(db: string, token: string | undefined, name?: string) {
  const record = operationRecorder(process.cwd(), db);
  await record({ operation: "init", outcome: "started" });
  try {
    await initialize(db, token, name, record);
    await record({ operation: "init", outcome: "succeeded" });
  } catch (error) {
    await record({ operation: "init", outcome: "failed" });
    throw error;
  }
}

async function initialize(db: string, token: string | undefined, name: string | undefined, record: OperationRecorder) {
  const dir = process.cwd();
  if (token !== undefined) {
    console.error("Warning: --token may expose credentials in shell history or process arguments and saves them in wiki9.toml. Prefer WIKI9_TOKEN or db9 login.");
  }
  const configPath = join(dir, "wiki9.toml");
  let previous: WikiConfig | undefined;
  try {
    // Do not persist a transient environment token when updating an existing config.
    previous = await loadConfig(dir, false);
    if (previous.db9?.database !== db) {
      throw new Error("Existing wiki9.toml uses a different database; use a separate directory");
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const wikiName = name || previous?.wiki?.name || "My Knowledge Base";
  const config: WikiConfig = {
    wiki: { name: wikiName },
    db9: { database: db, token: token ?? previous?.db9?.token ?? "" },
    search: { top_k: previous?.search?.top_k ?? 5 },
  };

  console.log(`Initializing wiki9 in ${displayText(dir)}...\n`);

  // Create directories
  for (const sub of ["wiki", "sources", ".agents/skills", ".claude"]) {
    await ensureDir(join(dir, sub));
    console.log(`  create ${sub}/`);
  }

  // Write config
  const configContent = stringify(config);
  if (!(await writeSafeFileIfMissing(dir, configPath, configContent, 0o600))) {
    const file = await open(configPath, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error("wiki9.toml must be a regular file");
      await file.chmod(0o600);
      await file.truncate(0);
      await file.writeFile(configContent);
    } finally {
      await file.close();
    }
    console.log("  update wiki9.toml");
  } else {
    console.log("  create wiki9.toml");
  }
  if (!previous || token !== undefined) {
    await record({
      operation: "credential-update",
      outcome: "succeeded",
      credentialSource: token !== undefined ? "argument"
        : process.env.WIKI9_TOKEN ? "environment"
        : config.db9.token ? "configuration" : "login",
    });
  }

  // Write .gitignore entry for config (contains credentials)
  const gitignorePath = join(dir, ".gitignore");
  const ignoreEntries = ["wiki9.toml", ".wiki9/"];
  try {
    const existing = (await readSafeFile(dir, gitignorePath)).toString("utf-8");
    const lines = existing.split(/\r?\n/).map((line) => line.trim());
    const lastNegation = lines.reduce((last, line, index) => line.startsWith("!") ? index : last, -1);
    const missingEntries = ignoreEntries.filter((entry) =>
      Math.max(lines.lastIndexOf(entry), lines.lastIndexOf(`/${entry}`)) <= lastNegation);
    if (missingEntries.length > 0) {
      const file = await open(gitignorePath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
      try {
        await file.writeFile(`\n${missingEntries.join("\n")}\n`);
      } finally {
        await file.close();
      }
      console.log(`  update .gitignore`);
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await writeSafeFileIfMissing(dir, gitignorePath, `${ignoreEntries.join("\n")}\n`);
    console.log(`  create .gitignore`);
  }

  // Write AGENTS.md
  await writeIfMissing(join(dir, "AGENTS.md"), agentsMdTemplate(wikiName));

  // Write skills
  await writeIfMissing(join(dir, ".agents", "skills", "ingest.md"), skillIngestTemplate);
  await writeIfMissing(join(dir, ".agents", "skills", "query.md"), skillQueryTemplate);
  await writeIfMissing(join(dir, ".agents", "skills", "lint.md"), skillLintTemplate);
  await ensureSymlink(join(dir, ".claude", "skills"), "../.agents/skills");

  const restoreMarker = join(dir, ".wiki9", "restore-incomplete");
  await writeSafeFileIfMissing(dir, restoreMarker, "Retry wiki9 init before syncing.\n", 0o600);

  // Initialize DB9 schema
  console.log(`\nInitializing DB9 schema...`);
  try {
    const runtimeConfig = await loadConfig(dir, token === undefined);
    const client = createClient(runtimeConfig);
    await record({ operation: "schema", outcome: "started" });
    try {
      await initSchema(client, db);
    } catch (error) {
      await record({ operation: "schema", outcome: "failed" });
      throw error;
    }
    await record({ operation: "schema", outcome: "succeeded" });
    console.log(`  DB9 schema initialized`);

    console.log(`\nPulling remote wiki data...`);
    const pulledWiki = await pullRemoteTree(client, db, dir, "/wiki");
    const pulledSources = await pullRemoteTree(client, db, dir, "/sources");
    const pulledLog = await pullRemoteFile(client, db, dir, "/log.md");
    console.log(`  pulled ${pulledWiki} wiki files, ${pulledSources} source files${pulledLog ? ", 1 log file" : ""}`);
  } catch {
    throw new Error("Initialization or remote restore failed. Retry `wiki9 init` before syncing.");
  }

  // Write log.md
  await writeIfMissing(join(dir, "log.md"), "# Wiki Log\n", 0o600);
  await unlink(restoreMarker);

  console.log(`\nDone! Open this directory with your AI agent to get started.`);
}
