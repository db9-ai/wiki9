import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "smol-toml";
import { loadConfig } from "../src/config.js";
import { syncCommand } from "../src/commands/sync.js";
import { initCommand } from "../src/commands/init.js";
import { collectSourceFiles, collectWikiPages } from "../src/utils/wiki.js";
import { remoteChildPath, writeSafeFileIfMissing } from "../src/utils/paths.js";
import { contentHash, fileHash } from "../src/utils/hash.js";
import { createClient, initSchema } from "../src/db.js";
import { backendError } from "../src/utils/errors.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readdir: vi.fn(fs.readdir) };
});

const remote = vi.hoisted(() => ({
  files: new Map<string, { bytes: Buffer; mtime: string }>(),
  index: new Map<string, string>(), links: new Set<string>(),
  calls: [] as string[], clock: 0, failInsertLinks: false, failWrite: false,
  failList: false, maliciousEntry: "", failSchema: false, failRemove: "",
}));
const missing = () => Object.assign(new Error("not found"), { code: "ENOENT" });
const fsClient = {
  stat: vi.fn(async (path: string) => {
    const file = remote.files.get(path);
    if (!file) throw missing();
    return { type: "file", size: file.bytes.length, mtime: file.mtime };
  }),
  readdir: vi.fn(async (path: string) => {
    if (remote.failList) throw new Error("directory unavailable");
    if (remote.maliciousEntry) return [{ path: remote.maliciousEntry, type: "file" }];
    const entries = new Map<string, { path: string; type: string; size: number; mtime: string }>();
    for (const file of remote.files.keys()) {
      if (!file.startsWith(`${path}/`)) continue;
      const parts = file.slice(path.length + 1).split("/");
      const child = `${path}/${parts[0]}`;
      const info = remote.files.get(file)!;
      entries.set(child, { path: child, type: parts.length > 1 ? "dir" : "file", size: info.bytes.length, mtime: info.mtime });
    }
    return [...entries.values()];
  }),
  writeFile: vi.fn(async (path: string, data: string | Uint8Array) => {
    if (remote.failWrite) throw new Error("write unavailable");
    const bytes = Buffer.from(data);
    remote.files.set(path, { bytes, mtime: new Date(2_000_000_000_000 + remote.clock++).toISOString() });
    return bytes.length;
  }),
  rm: vi.fn(async (path: string) => {
    if (path === remote.failRemove) throw new Error("remove unavailable SECRET");
    remote.files.delete(path);
  }),
  close: vi.fn(async () => {}),
};
function sqlStrings(sql: string): string[] {
  return [...sql.matchAll(/(E)?'((?:''|\\[\s\S]|[^'])*)'/g)].map((match) => {
    if (!match[1]) return match[2].replace(/''/g, "'");
    return match[2].replace(/''|\\([\s\S])/g, (escaped, character: string) =>
      escaped === "''" ? "'" : ({ n: "\n", r: "\r", t: "\t" }[character] ?? character));
  });
}
const client = {
  fs: {
    connect: vi.fn(async () => fsClient),
    exists: vi.fn(async (_db: string, path: string) => remote.files.has(path)
      || [...remote.files.keys()].some((key) => key.startsWith(`${path}/`))),
    list: vi.fn(async (_db: string, path: string) => fsClient.readdir(path)),
    readBinary: vi.fn(async (_db: string, path: string) => {
      const file = remote.files.get(path);
      if (!file) throw missing();
      return file.bytes;
    }),
  },
};
vi.mock("../src/db.js", () => ({
  createClient: vi.fn(() => client),
  initSchema: vi.fn(async () => { if (remote.failSchema) throw new Error("schema unavailable"); }),
  execSql: vi.fn(async (_client, _db, sql: string) => {
    remote.calls.push(sql);
    let rows: unknown[][] = [];
    if (sql.includes("SELECT slug, content_hash")) rows = [...remote.index].sort();
    else if (sql.includes("SELECT page_slug, source_path")) {
      rows = [...remote.links].sort().map((link) => link.split("\0"));
      if (sql.includes("WHERE page_slug IN")) {
        const slugs = sqlStrings(sql);
        rows = rows.filter(([slug]) => slugs.includes(slug));
      }
    } else if (sql.includes("INSERT INTO wiki_index")) {
      const [slug, , , hash] = sqlStrings(sql);
      remote.index.set(slug, hash);
    } else if (sql.includes("UPDATE wiki_index")) {
      remote.index.set(sqlStrings(sql.slice(sql.indexOf("WHERE")))[0], sql.match(/content_hash = '([^']+)'/)![1]);
    } else if (sql.includes("DELETE FROM wiki_index")) {
      const slugs = sqlStrings(sql);
      for (const slug of remote.index.keys()) if (slugs.includes(slug)) remote.index.delete(slug);
    } else if (sql.includes("INSERT INTO wiki_page_sources")) {
      if (remote.failInsertLinks) throw new Error("reference insert failed");
      const values = sqlStrings(sql);
      for (let offset = 0; offset < values.length; offset += 2) remote.links.add(`${values[offset]}\0${values[offset + 1]}`);
    } else if (sql.includes("DELETE FROM wiki_page_sources")) {
      const values = sqlStrings(sql);
      for (let offset = 0; offset < values.length; offset += 2) remote.links.delete(`${values[offset]}\0${values[offset + 1]}`);
    }
    return { rows, columns: [], row_count: rows.length };
  }),
}));

let dir: string;
let outside: string;
const config = { wiki: { name: "Test Wiki" }, db9: { database: "test-db", token: "test-token" }, search: { top_k: 5 } };
async function seedRemote(path: string, text: string | Uint8Array) {
  await fsClient.writeFile(path, text);
}
async function localPage(path = "topic.md", content = "# Topic\n") {
  await mkdir(join(dir, "wiki", path, ".."), { recursive: true });
  await writeFile(join(dir, "wiki", path), content);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wiki9-safety-"));
  outside = await mkdtemp(join(tmpdir(), "wiki9-outside-"));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("WIKI9_TOKEN", "");
  delete process.env.WIKI9_TOKEN;
  await mkdir(join(dir, "wiki"));
  await mkdir(join(dir, "sources"));
  await writeFile(join(dir, "wiki9.toml"), stringify(config));
  remote.files.clear(); remote.index.clear(); remote.links.clear(); remote.calls.length = 0;
  remote.failInsertLinks = remote.failWrite = remote.failList = remote.failSchema = false;
  remote.maliciousEntry = ""; remote.clock = 0;
  remote.failRemove = "";
  vi.mocked(readdir).mockClear(); fsClient.rm.mockClear(); fsClient.writeFile.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("file boundaries", () => {
  it("collects nested pages and arbitrary binary sources", async () => {
    await localPage("nested/topic.md");
    const bytes = Buffer.from([0, 1, 255, 17]);
    await writeFile(join(dir, "sources", "image.bin"), bytes);
    expect((await collectWikiPages(join(dir, "wiki")))[0].slug).toBe("nested/topic");
    expect((await collectSourceFiles(join(dir, "sources")))[0].bytes).toEqual(bytes);
  });
  it.each(["bad\\name.md", "bad\nname.md", "bad\tname.md"])("rejects unsupported local names before SQL writes: %j", async (name) => {
    await localPage(name);
    await expect(syncCommand()).rejects.toThrow(/Unsupported local path/);
    expect(remote.calls).toEqual([]);
    expect(fsClient.writeFile).not.toHaveBeenCalled();
  });
  it("rejects unsupported source filenames before remote writes", async () => {
    await writeFile(join(dir, "sources", "bad\nfile.bin"), "source");
    await expect(syncCommand()).rejects.toThrow(/Unsupported local path/);
    expect(remote.calls).toEqual([]);
  });
  it("hashes binary files with the complete SHA-256 digest", async () => {
    const bytes = Buffer.alloc(200_000, 173);
    const path = join(dir, "sources", "large.bin");
    await writeFile(path, bytes);
    expect(await fileHash(dir, path)).toBe(contentHash(bytes));
    expect(contentHash(bytes)).toHaveLength(64);
  });
  it.each(["wiki", "sources"])("rejects file symlinks in %s", async (sub) => {
    await writeFile(join(outside, "secret"), "secret");
    await symlink(join(outside, "secret"), join(dir, sub, "secret.md"));
    await expect(syncCommand()).rejects.toThrow(/symlink/);
    expect(remote.calls).toEqual([]);
    expect(fsClient.writeFile).not.toHaveBeenCalled();
  });
  it("rejects directory links and cycles", async () => {
    await symlink(join(dir, "sources"), join(dir, "sources", "cycle"));
    await expect(syncCommand()).rejects.toThrow(/symlink/);
  });
  it("rejects a symlinked sync root", async () => {
    await rm(join(dir, "wiki"), { recursive: true });
    await symlink(outside, join(dir, "wiki"));
    await expect(syncCommand()).rejects.toThrow(/Unsafe directory/);
  });
  it("rejects dangling log links", async () => {
    await symlink(join(outside, "missing"), join(dir, "log.md"));
    await expect(syncCommand()).rejects.toThrow();
    expect(remote.calls).toEqual([]);
  });
  it.each(["../escape", "/outside/file", "/wiki/../escape", "/wiki/sub/file", "/wiki/", "a\\b"])("rejects remote entry %s", (entry) => {
    expect(() => remoteChildPath("/wiki", entry)).toThrow();
  });
  it("accepts relative names and absolute direct children", () => {
    expect(remoteChildPath("/wiki", "topic.md")).toBe("/wiki/topic.md");
    expect(remoteChildPath("/wiki/sub", "/wiki/sub/topic.md")).toBe("/wiki/sub/topic.md");
  });
  it("does not follow intermediate or dangling destination links", async () => {
    await symlink(outside, join(dir, "wiki", "linked"));
    await expect(writeSafeFileIfMissing(dir, join(dir, "wiki", "linked", "new.md"), "bad")).rejects.toThrow();
    await symlink(join(outside, "missing"), join(dir, "wiki", "missing.md"));
    await expect(writeSafeFileIfMissing(dir, join(dir, "wiki", "missing.md"), "bad")).rejects.toThrow();
    await expect(lstat(join(outside, "missing"))).rejects.toThrow();
  });
});

describe("sync integrity", () => {
  it("aborts on directory read failures before remote writes", async () => {
    vi.mocked(readdir).mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    await expect(syncCommand()).rejects.toThrow(/permission denied/);
    expect(remote.calls).toEqual([]);
  });
  it("aborts on a missing directory instead of treating it as empty", async () => {
    await rm(join(dir, "sources"), { recursive: true });
    await expect(syncCommand()).rejects.toThrow();
    expect(remote.calls).toEqual([]);
  });
  it("aborts on subdirectory read failures before deleting anything", async () => {
    await mkdir(join(dir, "wiki", "nested"));
    vi.mocked(readdir).mockResolvedValueOnce(["nested"] as never)
      .mockRejectedValueOnce(Object.assign(new Error("nested unreadable"), { code: "EACCES" }));
    await expect(syncCommand()).rejects.toThrow(/nested unreadable/);
    expect(remote.calls).toEqual([]);
    expect(fsClient.rm).not.toHaveBeenCalled();
  });
  it.each(["missing", "invalid-json", "invalid-path", "other-database", "old-version", "invalid-date"])("protects remote data with %s state", async (kind) => {
    await seedRemote("/wiki/remote.md", "# Remote");
    remote.index.set("remote", contentHash("# Remote"));
    if (kind !== "missing") {
      await mkdir(join(dir, ".wiki9"));
      const state = { version: 2, database: "test-db", lastSuccessfulSyncAt: "2020-01-01", wikiPaths: ["remote.md"], sourcePaths: [], hasLogFile: false, remoteSnapshot: "x" };
      if (kind === "invalid-path") state.wikiPaths = ["../remote.md"];
      if (kind === "other-database") state.database = "other-db";
      if (kind === "old-version") state.version = 1;
      if (kind === "invalid-date") state.lastSuccessfulSyncAt = "invalid";
      await writeFile(join(dir, ".wiki9", "sync-state.json"), kind === "invalid-json" ? "{" : JSON.stringify(state));
    }
    await expect(syncCommand()).rejects.toThrow(/Remote data was not changed/);
    expect(remote.calls.some((sql) => /INSERT|UPDATE|DELETE/.test(sql))).toBe(false);
    expect(fsClient.rm).not.toHaveBeenCalled();
    expect(remote.files.has("/wiki/remote.md")).toBe(true);
  });
  it("allows explicit full pruning", async () => {
    await seedRemote("/wiki/remote.md", "# Remote");
    remote.index.set("remote", contentHash("# Remote"));
    await syncCommand({ full: true, prune: true });
    expect(remote.files.size).toBe(0);
    expect(remote.index.size).toBe(0);
  });
  it.each([false, true])("preserves normal page, source and log deletion sync (full: %s)", async (full) => {
    await localPage("topic.md", "---\nsources: [data.bin]\n---\n# Topic");
    await writeFile(join(dir, "sources", "data.bin"), Buffer.from([0, 255]));
    await writeFile(join(dir, "log.md"), "history");
    await syncCommand();
    expect(remote.files.get("/sources/data.bin")!.bytes).toEqual(Buffer.from([0, 255]));
    expect(remote.links.size).toBe(1);
    await unlink(join(dir, "wiki", "topic.md"));
    await unlink(join(dir, "sources", "data.bin"));
    await unlink(join(dir, "log.md"));
    await syncCommand({ full });
    expect(remote.index.size).toBe(0);
    expect(remote.files.size).toBe(0);
    expect(remote.links.size).toBe(0);
  });
  it("preserves full scans and skips unchanged backup files", async () => {
    await localPage();
    await syncCommand();
    fsClient.writeFile.mockClear();
    await syncCommand({ full: true });
    expect(fsClient.writeFile).not.toHaveBeenCalled();
    expect(remote.index.get("topic")).toBe(contentHash("# Topic\n"));
  });
  it.each([false, true])("uploads changes that preserve old mtimes and sizes (full: %s)", async (full) => {
    await localPage("topic.md", "AAAA");
    await writeFile(join(dir, "sources", "data.bin"), Buffer.from([0, 1]));
    await writeFile(join(dir, "log.md"), "AAAA");
    await syncCommand();
    await localPage("topic.md", "BBBB");
    await writeFile(join(dir, "sources", "data.bin"), Buffer.from([0, 2]));
    await writeFile(join(dir, "log.md"), "BBBB");
    const old = new Date("2000-01-01");
    for (const path of ["wiki/topic.md", "sources/data.bin", "log.md"]) await utimes(join(dir, path), old, old);
    await syncCommand({ full });
    expect(remote.index.get("topic")).toBe(contentHash("BBBB"));
    expect(remote.files.get("/wiki/topic.md")!.bytes.toString()).toBe("BBBB");
    expect(remote.files.get("/sources/data.bin")!.bytes).toEqual(Buffer.from([0, 2]));
    expect(remote.files.get("/log.md")!.bytes.toString()).toBe("BBBB");
  });
  it("does not upload or re-embed content after only its mtime changes", async () => {
    await localPage();
    await syncCommand();
    fsClient.writeFile.mockClear(); remote.calls.length = 0;
    const later = new Date(Date.now() + 60_000);
    await utimes(join(dir, "wiki", "topic.md"), later, later);
    await syncCommand();
    expect(fsClient.writeFile).not.toHaveBeenCalled();
    expect(remote.calls.some((sql) => /INSERT|UPDATE/.test(sql))).toBe(false);
  });
  it("rebuilds matching-hash index rows and same-size poisoned files only on explicit replacement", async () => {
    await localPage("topic.md", "GOOD");
    await writeFile(join(dir, "sources", "data.bin"), Buffer.from([0, 1]));
    await writeFile(join(dir, "log.md"), "GOOD");
    await syncCommand();
    for (const path of ["/wiki/topic.md", "/log.md"]) {
      const file = remote.files.get(path)!;
      file.bytes = Buffer.from("EVIL");
    }
    remote.files.get("/sources/data.bin")!.bytes = Buffer.from([1, 0]);
    remote.calls.length = 0;
    await syncCommand({ full: true, prune: true });
    expect(remote.calls.some((sql) => sql.includes("UPDATE wiki_index") && sql.includes("embedding("))).toBe(true);
    expect(remote.files.get("/wiki/topic.md")!.bytes.toString()).toBe("GOOD");
    expect(remote.files.get("/sources/data.bin")!.bytes).toEqual(Buffer.from([0, 1]));
    expect(remote.files.get("/log.md")!.bytes.toString()).toBe("GOOD");
  });
  it("migrates a genuine version-two snapshot without false conflicts or losing tracked deletions", async () => {
    await localPage("topic.md", "# Topic\n");
    await localPage("removed.md", "# Removed\n");
    await syncCommand();
    const statePath = join(dir, ".wiki9", "sync-state.json");
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    for (const [slug, hash] of remote.index) remote.index.set(slug, hash.slice(0, 16));
    const index = [...remote.index].sort();
    const files = [...remote.files].map(([path, file]) => ({
      path, size: file.bytes.length, mtime: file.mtime,
    })).sort((left, right) => left.path.localeCompare(right.path));
    state.version = 2;
    state.remoteSnapshot = contentHash(JSON.stringify([index, [], files])).slice(0, 16);
    delete state.fileHashes;
    await writeFile(statePath, JSON.stringify(state));
    await unlink(join(dir, "wiki", "removed.md"));
    await syncCommand();
    expect(remote.index.has("removed")).toBe(false);
    expect(remote.files.has("/wiki/removed.md")).toBe(false);
    expect(remote.index.get("topic")).toHaveLength(64);
    const migrated = JSON.parse(await readFile(statePath, "utf-8"));
    expect(migrated.version).toBe(3);
    expect(migrated.fileHashes["wiki/topic.md"]).toBe(contentHash("# Topic\n"));
    expect(migrated.remoteSnapshot).toHaveLength(64);
  });
  it("retains the remote conflict guard while migrating version-two snapshots", async () => {
    await localPage();
    await syncCommand();
    const statePath = join(dir, ".wiki9", "sync-state.json");
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    state.version = 2;
    state.remoteSnapshot = state.remoteSnapshot.slice(0, 16);
    delete state.fileHashes;
    await writeFile(statePath, JSON.stringify(state));
    await seedRemote("/wiki/other.md", "changed remotely");
    fsClient.writeFile.mockClear();
    await expect(syncCommand()).rejects.toThrow(/Remote data changed/);
    expect(fsClient.writeFile).not.toHaveBeenCalled();
  });
  it("protects remote-only content on the lightweight path even if the saved snapshot matches it", async () => {
    await localPage();
    await syncCommand();
    await seedRemote("/sources/untracked.bin", Buffer.from([7]));
    const statePath = join(dir, ".wiki9", "sync-state.json");
    const state = JSON.parse(await readFile(statePath, "utf-8"));
    const files = [...remote.files].map(([path, file]) => ({
      path, size: file.bytes.length, mtime: file.mtime,
    })).sort((left, right) => left.path.localeCompare(right.path));
    state.remoteSnapshot = contentHash(JSON.stringify([[...remote.index].sort(), [], files]));
    await writeFile(statePath, JSON.stringify(state));
    await expect(syncCommand()).rejects.toThrow(/Remote data was not changed/);
    expect(remote.files.has("/sources/untracked.bin")).toBe(true);
  });
  it("supports ordinary apostrophes, Unicode and spaces across repeat syncs and reference changes", async () => {
    const source = "资料's file.bin";
    await localPage("目录/topic's name.md", `---\ntags: [team's tag]\nsources: [${source}]\n---\n# Topic`);
    await writeFile(join(dir, "sources", source), Buffer.from([0, 255]));
    await syncCommand();
    expect(remote.index.has("目录/topic's name")).toBe(true);
    expect(remote.links.has(`目录/topic's name\0${source}`)).toBe(true);
    await syncCommand();
    await localPage("目录/topic's name.md", "---\nsources: []\n---\n# Updated");
    await syncCommand();
    expect(remote.links.size).toBe(0);
    await unlink(join(dir, "wiki", "目录", "topic's name.md"));
    await syncCommand();
    expect(remote.index.size).toBe(0);
  });
  it("stops a stale directory before it overwrites another writer", async () => {
    await localPage(); await syncCommand();
    await seedRemote("/wiki/topic.md", "# Edited elsewhere");
    fsClient.writeFile.mockClear(); remote.calls.length = 0;
    await expect(syncCommand()).rejects.toThrow(/Remote data changed/);
    expect(remote.calls.every((sql) => sql.trim().startsWith("SELECT"))).toBe(true);
    expect(fsClient.writeFile).not.toHaveBeenCalled();
  });
  it("does not remove old references if inserting new ones fails", async () => {
    await localPage("topic.md", "---\nsources: [new.txt]\n---\n# Topic");
    remote.links.add("topic\0old.txt"); remote.failInsertLinks = true;
    await expect(syncCommand()).rejects.toThrow(/reference insert failed/);
    expect(remote.links.has("topic\0old.txt")).toBe(true);
    expect(remote.calls.some((sql) => sql.includes("DELETE FROM wiki_page_sources"))).toBe(false);
  });
  it("fails on remote directory errors without deleting anything", async () => {
    remote.failList = true;
    await expect(syncCommand()).rejects.toThrow(/directory unavailable/);
    expect(remote.calls.every((sql) => sql.startsWith("SELECT"))).toBe(true);
    expect(fsClient.rm).not.toHaveBeenCalled();
  });
  it("rejects remote traversal entries even during explicit pruning", async () => {
    remote.maliciousEntry = "/wiki/../outside";
    await expect(syncCommand({ full: true, prune: true })).rejects.toThrow(/Invalid remote/);
    expect(fsClient.rm).not.toHaveBeenCalled();
  });
  it("does not record success after backup writes fail", async () => {
    await localPage(); remote.failWrite = true;
    await expect(syncCommand()).rejects.toThrow(/File sync failed/);
    await expect(readFile(join(dir, ".wiki9", "sync-state.json"))).rejects.toThrow();
    expect(console.log).not.toHaveBeenCalledWith("\nSync complete:");
  });
  it("requires --full with --prune", async () => {
    await expect(syncCommand({ prune: true })).rejects.toThrow(/requires --full/);
  });
  it("records deletion plans and partial failures without secrets or claiming success", async () => {
    await localPage("first.md", "first");
    await localPage("second.md", "second");
    await syncCommand();
    const statePath = join(dir, ".wiki9", "sync-state.json");
    const before = await readFile(statePath, "utf-8");
    await unlink(join(dir, "wiki", "first.md"));
    await unlink(join(dir, "wiki", "second.md"));
    remote.failRemove = "/wiki/second.md";
    await expect(syncCommand()).rejects.toThrow(/File sync failed/);
    expect(await readFile(statePath, "utf-8")).toBe(before);
    const log = await readFile(join(dir, ".wiki9", "operations.jsonl"), "utf-8");
    expect(log).not.toMatch(/test-token|SECRET|remove unavailable/);
    const entries = log.trim().split("\n").map((line) => JSON.parse(line));
    const runId = entries.at(-1).runId;
    const failedRun = entries.filter((entry) => entry.runId === runId);
    expect(failedRun.some((entry) => entry.outcome === "planned")).toBe(true);
    expect(failedRun.some((entry) => entry.operation === "delete-file" && entry.outcome === "succeeded")).toBe(true);
    expect(failedRun.some((entry) => entry.operation === "delete-file" && entry.outcome === "failed")).toBe(true);
    expect(failedRun.at(-1)).toMatchObject({ operation: "sync", outcome: "failed" });
    expect((await lstat(join(dir, ".wiki9", "operations.jsonl"))).mode & 0o777).toBe(0o600);
  });
  it("warns about unavailable operation records without discarding a successful sync", async () => {
    await mkdir(join(dir, ".wiki9"));
    await mkdir(join(dir, ".wiki9", "operations.jsonl"));
    await localPage();
    await syncCommand();
    expect(console.error).toHaveBeenCalledWith("Warning: could not write the local operation record.");
    expect(remote.index.has("topic")).toBe(true);
    expect(await readFile(join(dir, ".wiki9", "sync-state.json"), "utf-8")).toContain('"version": 3');
  });
  it("does not follow a substituted operation log symlink", async () => {
    await mkdir(join(dir, ".wiki9"));
    const target = join(outside, "untouched");
    await writeFile(target, "keep");
    await symlink(target, join(dir, ".wiki9", "operations.jsonl"));
    await localPage();
    await syncCommand();
    expect(await readFile(target, "utf-8")).toBe("keep");
    expect(console.error).toHaveBeenCalledWith("Warning: could not write the local operation record.");
  });
  it("does not drop the legacy table during schema initialization", async () => {
    const { initSchema } = await vi.importActual<typeof import("../src/db.js")>("../src/db.js");
    const sql = vi.fn(async () => ({ error: null }));
    await initSchema({ databases: { sql } } as never, "test-db");
    expect(sql.mock.calls.map((args) => args[1]).join("\n")).not.toMatch(/DROP TABLE/i);
  });
});

describe("initialization and credentials", () => {
  it.each(['"10; DELETE FROM wiki_index"', '"5"', "-1", "1.5", "9007199254740992"])("rejects invalid top_k %s", async (topK) => {
    await writeFile(join(dir, "wiki9.toml"), `[db9]\ndatabase = "test-db"\n[search]\ntop_k = ${topK}\n`);
    await expect(loadConfig()).rejects.toThrow(/non-negative safe integer|cannot parse TOML/);
  });
  it.each([0, 5, 100])("accepts top_k %s", async (value) => {
    await writeFile(join(dir, "wiki9.toml"), stringify({ ...config, search: { top_k: value } }));
    expect((await loadConfig()).search.top_k).toBe(value);
  });
  it("tightens existing config permissions and supports transient environment tokens", async () => {
    await chmod(join(dir, "wiki9.toml"), 0o644);
    vi.stubEnv("WIKI9_TOKEN", "environment-token");
    expect((await loadConfig()).db9.token).toBe("environment-token");
    expect((await lstat(join(dir, "wiki9.toml"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, "wiki9.toml"), "utf-8")).not.toContain("environment-token");
  });
  it("rejects empty environment tokens instead of silently switching identity", async () => {
    vi.stubEnv("WIKI9_TOKEN", "");
    await expect(loadConfig()).rejects.toThrow(/WIKI9_TOKEN is empty/);
  });
  it("uses an explicit init token ahead of an environment token", async () => {
    vi.stubEnv("WIKI9_TOKEN", "environment-token");
    await initCommand("test-db", "explicit-token");
    expect(createClient).toHaveBeenLastCalledWith(expect.objectContaining({
      db9: { database: "test-db", token: "explicit-token" },
    }));
    expect((await loadConfig(dir, false)).db9.token).toBe("explicit-token");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("--token may expose"));
    const output = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(output).not.toMatch(/explicit-token|environment-token/);
  });
  it("escapes TOML values, rotates tokens and retains the skills link", async () => {
    const name = 'Name "quoted"\n[extra]'; const token = 'token"\\\n';
    await writeFile(join(dir, ".gitignore"), "# wiki9.toml is mentioned here\n");
    await initCommand("test-db", token, name);
    const loaded = await loadConfig();
    expect(loaded.wiki.name).toBe(name); expect(loaded.db9.token).toBe(token);
    const agents = await readFile(join(dir, "AGENTS.md"), "utf-8");
    expect(agents.split("\n")[0]).toContain('Name "quoted"');
    expect(agents).not.toContain("\n[extra]");
    expect((await lstat(join(dir, ".claude", "skills"))).isSymbolicLink()).toBe(true);
    expect((await readFile(join(dir, ".gitignore"), "utf-8")).split("\n")).toContain("wiki9.toml");
    await initCommand("test-db", "replacement");
    expect((await loadConfig()).db9.token).toBe("replacement");
    expect((await loadConfig()).wiki.name).toBe(name);
  });
  it.each(
    (["new", "matching", "different", "non-link"] as const).flatMap((branch) =>
      [false, true].map((controls) => ({ branch, controls }))),
  )("safely logs the $branch skills branch with controls=$controls without changing its behavior", async ({ branch, controls }) => {
    const workspaceName = controls ? "workspace\n\u001b[2J" : "workspace";
    const workspace = join(dir, workspaceName);
    await mkdir(join(workspace, ".claude"), { recursive: true });
    await writeFile(join(workspace, "wiki9.toml"), stringify(config));
    vi.mocked(process.cwd).mockReturnValue(workspace);

    const linkPath = join(workspace, ".claude", "skills");
    const customTarget = controls ? "custom\n\u001b[2J\t\u009b\u202e" : "custom-skills";
    const linkTarget = branch === "different" ? customTarget : "../.agents/skills";
    if (branch === "non-link") await writeFile(linkPath, "Existing skills");
    else if (branch !== "new") await symlink(linkTarget, linkPath, "dir");

    await initCommand("test-db", undefined);

    const renderedWorkspace = controls ? `${dir}/workspace\\n\\u001b[2J` : workspace;
    const renderedPath = `${renderedWorkspace}/.claude/skills`;
    const renderedTarget = controls ? "custom\\n\\u001b[2J\\t\\u009b\\u202e" : customTarget;
    const expected = {
      new: `  create ${renderedPath} -> ../.agents/skills`,
      matching: `  skip ${renderedPath} (symlink exists)`,
      different: `  skip ${renderedPath} (points to ${renderedTarget})`,
      "non-link": `  skip ${renderedPath} (exists and is not a symlink)`,
    }[branch];
    expect(console.log).toHaveBeenCalledWith(expected);
    if (branch === "non-link") {
      expect((await lstat(linkPath)).isFile()).toBe(true);
      expect(await readFile(linkPath, "utf-8")).toBe("Existing skills");
    } else {
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(linkPath)).toBe(linkTarget);
    }
  });
  it("bounds a long existing skills target only in the log", async () => {
    await mkdir(join(dir, ".claude"));
    const linkPath = join(dir, ".claude", "skills");
    const target = "custom-".repeat(100);
    await symlink(target, linkPath, "dir");

    await initCommand("test-db", undefined);

    expect(console.log).toHaveBeenCalledWith(`  skip ${linkPath} (points to ${target.slice(0, 500)}…)`);
    expect(await readlink(linkPath)).toBe(target);
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
  });
  it("uses login credentials when no token is configured", async () => {
    await unlink(join(dir, "wiki9.toml"));
    await initCommand("test-db", undefined);
    expect((await loadConfig()).db9.token).toBe("");
  });
  it("restores ignore protection after negated patterns", async () => {
    await writeFile(join(dir, ".gitignore"), "wiki9.toml\n.wiki9/\n!wiki9.toml\n!.wiki9/\n");
    await initCommand("test-db", undefined);
    const lines = (await readFile(join(dir, ".gitignore"), "utf-8")).trim().split("\n");
    expect(lines.slice(-2)).toEqual(["wiki9.toml", ".wiki9/"]);
  });
  it("does not change databases on repeated init", async () => {
    await expect(initCommand("different-db", "new-token")).rejects.toThrow(/different database/);
    expect((await loadConfig()).db9.database).toBe("test-db");
  });
  it("restores nested remote files without overwriting existing local content", async () => {
    await localPage();
    await seedRemote("/wiki/topic.md", "remote topic");
    await seedRemote("/wiki/nested/other.md", "remote other");
    await seedRemote("/sources/data.bin", Buffer.from([0, 255]));
    await initCommand("test-db", undefined);
    expect(await readFile(join(dir, "wiki", "topic.md"), "utf-8")).toBe("# Topic\n");
    expect(await readFile(join(dir, "wiki", "nested", "other.md"), "utf-8")).toBe("remote other");
    expect(await readFile(join(dir, "sources", "data.bin"))).toEqual(Buffer.from([0, 255]));
    for (const path of ["wiki/nested/other.md", "sources/data.bin", "log.md"]) {
      expect((await lstat(join(dir, path))).mode & 0o777).toBe(0o600);
    }
    expect((await lstat(join(dir, "wiki", "nested"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(dir, "wiki", "topic.md"))).mode & 0o777).toBe(0o644);
  });
  it("preserves existing agent instructions while recording credential updates without values", async () => {
    await writeFile(join(dir, "AGENTS.md"), "# User instructions\n");
    await initCommand("test-db", "SECRET-credential", "New\n## Injected");
    expect(await readFile(join(dir, "AGENTS.md"), "utf-8")).toBe("# User instructions\n");
    const log = await readFile(join(dir, ".wiki9", "operations.jsonl"), "utf-8");
    expect(log).toContain('"operation":"credential-update"');
    expect(log).not.toContain("SECRET-credential");
  });
  it("leaves a failed restore blocked until init succeeds", async () => {
    remote.failSchema = true;
    await expect(initCommand("test-db", undefined)).rejects.toThrow(/Initialization or remote restore failed/);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Done!"));
    await expect(syncCommand()).rejects.toThrow(/restore is incomplete/);
    remote.failSchema = false; await initCommand("test-db", undefined);
    await syncCommand();
  });
  it("rejects remote restore traversal", async () => {
    await seedRemote("/wiki/topic.md", "page"); remote.maliciousEntry = "/wiki/../../outside.md";
    await expect(initCommand("test-db", undefined)).rejects.toThrow(/restore failed/);
    expect(client.fs.readBinary).not.toHaveBeenCalledWith("test-db", "/wiki/../../outside.md");
  });
  it("rejects symlinked restore directories and dangling destination links", async () => {
    await seedRemote("/wiki/nested/file.md", "remote");
    await symlink(outside, join(dir, "wiki", "nested"));
    await expect(initCommand("test-db", undefined)).rejects.toThrow(/restore failed/);
    await expect(lstat(join(outside, "file.md"))).rejects.toThrow();
    await unlink(join(dir, "wiki", "nested"));
    remote.files.clear(); await seedRemote("/wiki/file.md", "remote");
    await symlink(join(outside, "missing"), join(dir, "wiki", "file.md"));
    await expect(initCommand("test-db", undefined)).rejects.toThrow(/restore failed/);
    await expect(lstat(join(outside, "missing"))).rejects.toThrow();
  });
  it("does not expose malformed configuration secrets in errors", async () => {
    await writeFile(join(dir, "wiki9.toml"), '[db9]\ntoken = "SECRET" invalid\n');
    await expect(loadConfig()).rejects.toThrow("Invalid wiki9.toml: cannot parse TOML");
    await expect(loadConfig()).rejects.not.toThrow(/SECRET/);
  });
});

describe("initialization error diagnostics", () => {
  const retryMessage = "Initialization or remote restore failed. Retry `wiki9 init` before syncing.";
  const secret = "SECRET SQL and credentials\n\u001b[31m";

  it.each([
    [0, "42501"], [1, "42501"], [2, "42501"],
    [0, "42601"], [1, "42601"], [2, "42601"],
    [0, "HTTP"], [1, "HTTP"], [2, "HTTP"],
  ] as const)("preserves safe diagnostics at request %i for %s", async (failedRequest, code) => {
    const actual = await vi.importActual<typeof import("../src/db.js")>("../src/db.js");
    const sql = vi.fn().mockResolvedValue({ error: null });
    for (let request = 0; request < failedRequest; request++) {
      sql.mockResolvedValueOnce({ error: null });
    }
    if (code === "HTTP") {
      sql.mockRejectedValueOnce(Object.assign(new Error(secret), { status: 403, cause: { token: secret } }));
    } else {
      sql.mockResolvedValueOnce({ error: { code, message: secret, details: { token: secret } } });
    }
    vi.mocked(initSchema).mockImplementationOnce(() => actual.initSchema({ databases: { sql } } as never, "test-db"));
    const restoreCalls = vi.mocked(client.fs.exists).mock.calls.length;
    const failure = await initCommand("test-db", undefined).catch((error: unknown) => error);
    const stage = failedRequest === 0 ? "Schema init failed" : "Index initialization failed";
    const state = code === "HTTP" ? " (HTTP 403)" : ` (code ${code})`;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(`${retryMessage} ${stage}${state}`);
    expect((failure as Error).cause).toBeUndefined();
    expect(sql).toHaveBeenCalledTimes(failedRequest + 1);
    expect(client.fs.exists).toHaveBeenCalledTimes(restoreCalls);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Done!"));
    expect(await readFile(join(dir, ".wiki9", "restore-incomplete"), "utf-8")).toContain("Retry wiki9 init");
    const operations = await readFile(join(dir, ".wiki9", "operations.jsonl"), "utf-8");
    const records = operations.trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "schema", outcome: "failed" }),
      expect.objectContaining({ operation: "init", outcome: "failed" }),
    ]));
    const output = [String(failure), operations, ...vi.mocked(console.log).mock.calls.flat(),
      ...vi.mocked(console.error).mock.calls.flat()].join("\n");
    expect(output).not.toMatch(/SECRET|\u001b|SQL and credentials/);
    await expect(syncCommand()).rejects.toThrow(/restore is incomplete/);
    await initCommand("test-db", undefined);
    await expect(lstat(join(dir, ".wiki9", "restore-incomplete"))).rejects.toMatchObject({ code: "ENOENT" });
    await syncCommand();
  });

  it("preserves a safe stage when the backend provides no valid state", async () => {
    vi.mocked(initSchema).mockRejectedValueOnce(backendError("Schema init failed", new Error(secret)));
    await expect(initCommand("test-db", undefined)).rejects.toThrow(`${retryMessage} Schema init failed`);
  });

  it.each([
    ["message prefix", () => new Error(`Schema init failed (code 42501) ${secret}`)],
    ["error name", () => Object.assign(new Error(secret), { name: "BackendError" })],
    ["object name", () => ({ name: "BackendError", message: secret, code: "42501", status: 403 })],
    ["status fields", () => Object.assign(new Error(secret), { code: "42501", status: 403, cause: secret })],
    ["string", () => secret],
    ["null", () => null],
  ])("redacts untrusted schema and file errors with %s", async (_label, makeError) => {
    for (const phase of ["schema", "restore"]) {
      if (phase === "schema") vi.mocked(initSchema).mockRejectedValueOnce(makeError());
      else vi.mocked(client.fs.exists).mockRejectedValueOnce(makeError());
      const failure = await initCommand("test-db", undefined).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(retryMessage);
      expect((failure as Error).cause).toBeUndefined();
      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Done!"));
      await expect(syncCommand()).rejects.toThrow(/restore is incomplete/);
    }
  });
});
