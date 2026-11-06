import { lstat, open, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { contentHash, fileHash } from "../utils/hash.js";
import { ensureSafeDirectory, isNotFound, isRelativeFilePath, readSafeFile, remoteChildPath } from "../utils/paths.js";
import { loadConfig } from "../config.js";
import { createClient, execSql, initSchema } from "../db.js";
import { escapeSqlLiteral } from "../utils/sql.js";
import { displayText } from "../utils/output.js";
import { operationRecorder, type OperationRecorder } from "../utils/operations.js";
import {
  collectSourceFileEntries,
  collectWikiPageEntries,
  loadSourceFile,
  loadWikiPage,
  parseFrontmatter,
  type SourceFileEntry,
  type WikiPageEntry,
} from "../utils/wiki.js";

const SYNC_STATE_DIR = ".wiki9";
const SYNC_STATE_FILE = "sync-state.json";
const SYNC_STATE_VERSION = 3;

interface SyncOptions {
  full?: boolean;
  prune?: boolean;
}

interface SyncableFile {
  path: string;
  size: number;
  mtimeMs: number;
  forceWrite?: boolean;
  write(): Promise<number>;
}

interface PageSourceRow {
  pageSlug: string;
  sourcePath: string;
}

interface SyncState {
  version: number;
  database: string;
  lastSuccessfulSyncAt: string;
  wikiPaths: string[];
  sourcePaths: string[];
  hasLogFile: boolean;
  remoteSnapshot: string;
  fileHashes: Record<string, string>;
}

interface DeletionPlan {
  paths: string[];
  slugs: string[];
}

function escapeArray(arr: string[]): string {
  if (arr.length === 0) return "'{}'";
  return `ARRAY[${arr.map(escapeSqlLiteral).join(",")}]`;
}

function escapeSqlList(values: string[]): string {
  return values.map(escapeSqlLiteral).join(", ");
}

function syncStatePath(dir: string): string {
  return join(dir, SYNC_STATE_DIR, SYNC_STATE_FILE);
}

async function loadSyncState(dir: string, dbId: string): Promise<SyncState | null> {
  try {
    const raw = (await readSafeFile(dir, syncStatePath(dir))).toString("utf-8");
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    if (
      !parsed || (parsed.version !== 2 && parsed.version !== SYNC_STATE_VERSION)
      || parsed.database !== dbId
      || typeof parsed.lastSuccessfulSyncAt !== "string"
      || !Number.isFinite(Date.parse(parsed.lastSuccessfulSyncAt))
      || Date.parse(parsed.lastSuccessfulSyncAt) > Date.now()
      || !Array.isArray(parsed.wikiPaths)
      || !parsed.wikiPaths.every((value) => isRelativeFilePath(value) && value.endsWith(".md"))
      || !Array.isArray(parsed.sourcePaths)
      || !parsed.sourcePaths.every(isRelativeFilePath)
      || typeof parsed.hasLogFile !== "boolean"
      || typeof parsed.remoteSnapshot !== "string"
      || !(parsed.version === 2 ? /^[a-f0-9]{16}$/ : /^[a-f0-9]{64}$/).test(parsed.remoteSnapshot)
    ) {
      return null;
    }
    const fileHashes: Record<string, string> | undefined = parsed.version === 2 ? {} : parsed.fileHashes;
    const paths = [
      ...parsed.wikiPaths.map((path) => `wiki/${path}`),
      ...parsed.sourcePaths.map((path) => `sources/${path}`),
      ...(parsed.hasLogFile ? ["log.md"] : []),
    ];
    if (!fileHashes || typeof fileHashes !== "object" || Array.isArray(fileHashes)
      || (parsed.version === SYNC_STATE_VERSION && (
        Object.keys(fileHashes).length !== paths.length
        || !paths.every((path) => Object.hasOwn(fileHashes, path) && /^[a-f0-9]{64}$/.test(fileHashes[path]))
      ))) return null;
    return {
      version: parsed.version,
      database: dbId,
      lastSuccessfulSyncAt: parsed.lastSuccessfulSyncAt,
      wikiPaths: [...new Set(parsed.wikiPaths)],
      sourcePaths: [...new Set(parsed.sourcePaths)],
      hasLogFile: parsed.hasLogFile,
      remoteSnapshot: parsed.remoteSnapshot,
      fileHashes,
    };
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function saveSyncState(
  dir: string,
  wikiEntries: WikiPageEntry[],
  sourceEntries: SourceFileEntry[],
  hasLogFile: boolean,
  dbId: string,
  startedAt: string,
  remoteSnapshot: string,
  fileHashes: Record<string, string>,
): Promise<void> {
  const stateDir = join(dir, SYNC_STATE_DIR);
  await ensureSafeDirectory(dir, stateDir, true, 0o700);
  const state: SyncState = {
    version: SYNC_STATE_VERSION,
    database: dbId,
    lastSuccessfulSyncAt: startedAt,
    wikiPaths: wikiEntries.map((entry) => entry.path).sort(),
    sourcePaths: sourceEntries.map((entry) => entry.path).sort(),
    hasLogFile,
    remoteSnapshot,
    fileHashes,
  };
  const temporaryPath = join(stateDir, `sync-state-${randomUUID()}.tmp`);
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(state, null, 2)}\n`);
  } finally {
    await file.close();
  }
  await rename(temporaryPath, syncStatePath(dir));
}

async function collectLocalHashes(
  dir: string, wikiEntries: WikiPageEntry[], sourceEntries: SourceFileEntry[], hasLogFile: boolean,
): Promise<Record<string, string>> {
  const paths = [
    ...wikiEntries.map((entry) => `wiki/${entry.path}`),
    ...sourceEntries.map((entry) => `sources/${entry.path}`),
    ...(hasLogFile ? ["log.md"] : []),
  ];
  const hashes: Record<string, string> = {};
  for (const path of paths) hashes[path] = await fileHash(dir, join(dir, path));
  return hashes;
}

function shouldWriteRemote(
  remote: { type: string; size: number; mtime: string } | null,
  local: { size: number; mtimeMs: number },
): boolean {
  if (!remote || remote.type !== "file") return true;
  if (remote.size !== local.size) return true;

  const remoteMtimeMs = Date.parse(remote.mtime);
  if (Number.isNaN(remoteMtimeMs)) return true;

  return remoteMtimeMs < local.mtimeMs;
}

function logProgress(label: string, current: number, total: number) {
  console.log(`  ${label}: ${current}/${total}`);
}

function pageSourceKey(row: PageSourceRow): string {
  return `${row.pageSlug}\0${row.sourcePath}`;
}

function pageSourceRowsEqual(local: PageSourceRow[], remote: PageSourceRow[]): boolean {
  if (local.length !== remote.length) return false;

  const remoteKeys = new Set(remote.map(pageSourceKey));
  for (const row of local) {
    if (!remoteKeys.has(pageSourceKey(row))) return false;
  }
  return true;
}

function buildPageSourceValues(rows: PageSourceRow[]): string {
  return rows
    .map((row) => `(${escapeSqlLiteral(row.pageSlug)}, ${escapeSqlLiteral(row.sourcePath)})`)
    .join(",\n");
}

function chunkRows<T>(rows: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < rows.length; start += chunkSize) {
    chunks.push(rows.slice(start, start + chunkSize));
  }
  return chunks;
}

async function walkRemoteFiles(
  fsClient: { readdir(path: string): Promise<Array<{ path: string; type: string; size: number; mtime: string }>> },
  remotePath: string,
): Promise<Array<{ path: string; size: number; mtime: string }>> {
  let entries: Array<{ path: string; type: string; size: number; mtime: string }>;
  try {
    entries = await fsClient.readdir(remotePath);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const files: Array<{ path: string; size: number; mtime: string }> = [];
  for (const entry of entries) {
    const childPath = remoteChildPath(remotePath, entry.path);
    if (entry.type === "dir") {
      files.push(...(await walkRemoteFiles(fsClient, childPath)));
      continue;
    }
    if (entry.type !== "file") throw new Error("Cannot sync a remote special file");
    files.push({ path: childPath, size: entry.size, mtime: entry.mtime });
  }
  return files;
}

async function localLogExists(dir: string): Promise<boolean> {
  try {
    await readSafeFile(dir, join(dir, "log.md"));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function inspectRemote(client: ReturnType<typeof createClient>, dbId: string) {
  const index = await execSql(client, dbId, "SELECT slug, content_hash FROM wiki_index ORDER BY slug");
  const references = await execSql(client, dbId,
    "SELECT page_slug, source_path FROM wiki_page_sources ORDER BY page_slug, source_path");
  const fsClient = await client.fs.connect(dbId);
  try {
    const files = [
      ...(await walkRemoteFiles(fsClient, "/wiki")),
      ...(await walkRemoteFiles(fsClient, "/sources")),
    ];
    try {
      const log = await fsClient.stat("/log.md");
      files.push({ path: "/log.md", size: log.size, mtime: log.mtime });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const snapshot = contentHash(JSON.stringify([index.rows, references.rows, files]));
    return {
      indexRows: index.rows,
      referenceRows: references.rows,
      paths: files.map((file) => file.path),
      snapshot,
      legacySnapshot: snapshot.slice(0, 16),
    };
  } finally {
    await fsClient.close();
  }
}

function requirePruneApproval(
  remote: Awaited<ReturnType<typeof inspectRemote>>,
  state: SyncState | null, wikiEntries: WikiPageEntry[], sourceEntries: SourceFileEntry[],
  hasLogFile: boolean, prune: boolean,
): DeletionPlan {
  const localSlugs = new Set(wikiEntries.map((entry) => entry.slug));
  const previousSlugs = new Set(state?.wikiPaths.map((path) => path.replace(/\.md$/, "")));
  const localPaths = new Set([
    ...wikiEntries.map((entry) => `/wiki/${entry.path}`),
    ...sourceEntries.map((entry) => `/sources/${entry.path}`),
    ...(hasLogFile ? ["/log.md"] : []),
  ]);
  const previousPaths = new Set([
    ...(state?.wikiPaths.map((path) => `/wiki/${path}`) ?? []),
    ...(state?.sourcePaths.map((path) => `/sources/${path}`) ?? []),
    ...(state?.hasLogFile ? ["/log.md"] : []),
  ]);
  const stalePaths = remote.paths.filter((path) => !localPaths.has(path));
  const unknown = [
    ...stalePaths.filter((path) => !previousPaths.has(path)),
    ...remote.indexRows.filter(([slug]) => !localSlugs.has(slug as string) && !previousSlugs.has(slug as string))
      .map(([slug]) => `index: ${slug}`),
    ...remote.referenceRows.filter(([slug]) => !localSlugs.has(slug as string) && !previousSlugs.has(slug as string))
      .map(([slug, source]) => `reference: ${slug} -> ${source}`),
  ];
  if (unknown.length > 0) {
    console.log(`Remote-only data outside the saved sync state (${unknown.length} entries):`);
    for (const path of unknown) console.log(`  ${displayText(path)}`);
    if (!prune) {
      throw new Error("Remote data was not changed. Restore missing files with `wiki9 init`, or review the list and explicitly run `wiki9 sync --full --prune`.");
    }
  }
  const slugs = [...new Set([
    ...remote.indexRows.filter(([slug]) => !localSlugs.has(slug as string)).map(([slug]) => slug as string),
    ...[...previousSlugs].filter((slug) => !localSlugs.has(slug)),
  ])];
  return { paths: stalePaths, slugs };
}

async function deleteSql(
  client: ReturnType<typeof createClient>, dbId: string, sql: string, targets: string[],
  operation: "delete-index" | "delete-references", record: OperationRecorder,
): Promise<void> {
  try {
    await execSql(client, dbId, sql);
    await record({ operation, outcome: "succeeded", targets });
  } catch (error) {
    await record({ operation, outcome: "failed", targets });
    throw error;
  }
}

async function syncPageSourceReferencesFull(
  client: ReturnType<typeof createClient>,
  dbId: string,
  pageSourceRows: PageSourceRow[],
  record: OperationRecorder,
): Promise<void> {
  console.log(`Checking page-source references (${pageSourceRows.length} links)...`);
  const existing = await execSql(
    client,
    dbId,
    "SELECT page_slug, source_path FROM wiki_page_sources ORDER BY page_slug, source_path",
  );
  const existingRows: PageSourceRow[] = existing.rows.map((row) => ({
    pageSlug: row[0] as string,
    sourcePath: row[1] as string,
  }));

  if (pageSourceRowsEqual(pageSourceRows, existingRows)) {
    console.log("  page-source links unchanged; skipping rebuild");
    return;
  }

  console.log("  page-source links changed; rebuilding...");
  await reconcilePageSourceReferences(client, dbId, pageSourceRows, existingRows, record);
}

async function syncPageSourceReferencesLightweight(
  client: ReturnType<typeof createClient>,
  dbId: string,
  pageSourceRows: PageSourceRow[],
  affectedSlugs: string[],
  record: OperationRecorder,
): Promise<void> {
  console.log(`Checking page-source references (${affectedSlugs.length} affected pages)...`);
  if (affectedSlugs.length === 0) {
    console.log("  no page-source changes detected");
    return;
  }

  const existing = await execSql(
    client,
    dbId,
    `SELECT page_slug, source_path FROM wiki_page_sources WHERE page_slug IN (${escapeSqlList(affectedSlugs)}) ORDER BY page_slug, source_path`,
  );
  const existingRows: PageSourceRow[] = existing.rows.map((row) => ({
    pageSlug: row[0] as string,
    sourcePath: row[1] as string,
  }));

  if (pageSourceRowsEqual(pageSourceRows, existingRows)) {
    console.log("  page-source links unchanged; skipping update");
    return;
  }

  console.log("  page-source links changed; updating affected pages...");
  await reconcilePageSourceReferences(client, dbId, pageSourceRows, existingRows, record);
}

async function reconcilePageSourceReferences(
  client: ReturnType<typeof createClient>, dbId: string,
  desired: PageSourceRow[], existing: PageSourceRow[],
  record: OperationRecorder,
): Promise<void> {
  const desiredByKey = new Map(desired.map((row) => [pageSourceKey(row), row]));
  const existingKeys = new Set(existing.map(pageSourceKey));
  const additions = [...desiredByKey.values()].filter((row) => !existingKeys.has(pageSourceKey(row)));
  // Install all new links before removing obsolete ones, so failed inserts retain old links.
  for (const chunk of chunkRows(additions, 200)) {
    await execSql(client, dbId, `
      INSERT INTO wiki_page_sources (page_slug, source_path)
      VALUES ${buildPageSourceValues(chunk)} ON CONFLICT DO NOTHING
    `);
  }
  for (const chunk of chunkRows(existing.filter((row) => !desiredByKey.has(pageSourceKey(row))), 200)) {
    const predicates = chunk.map((row) =>
      `(page_slug = ${escapeSqlLiteral(row.pageSlug)} AND source_path = ${escapeSqlLiteral(row.sourcePath)})`);
    await deleteSql(client, dbId, `DELETE FROM wiki_page_sources WHERE ${predicates.join(" OR ")}`,
      chunk.map((row) => `${row.pageSlug} -> ${row.sourcePath}`), "delete-references", record);
  }
  logProgress("page-source links", desiredByKey.size, desiredByKey.size);
}

async function syncFs9Files(
  files: SyncableFile[],
  statsLabel: string,
  progressLabel: string,
  statFile?: (path: string) => Promise<{ type: string; size: number; mtime: string }>,
): Promise<{ written: number; skipped: number }> {
  let written = 0;
  let skipped = 0;

  if (files.length === 0) {
    console.log(`  ${statsLabel}: no local files`);
    return { written, skipped };
  }

  const progressInterval = Math.max(1, Math.min(25, Math.floor(files.length / 4)));
  for (const [index, file] of files.entries()) {
    let shouldWrite = true;
    if (statFile && !file.forceWrite) {
      let remote: { type: string; size: number; mtime: string } | null = null;
      try {
        remote = await statFile(file.path);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      shouldWrite = shouldWriteRemote(remote, file);
    }

    if (shouldWrite) {
      await file.write();
      written++;
    } else {
      skipped++;
    }

    const processed = index + 1;
    if (processed === files.length || processed % progressInterval === 0) {
      logProgress(progressLabel, processed, files.length);
    }
  }

  console.log(`  ${statsLabel}: ${written} written, ${skipped} skipped`);
  return { written, skipped };
}

async function removeFs9Paths(
  paths: string[],
  statsLabel: string,
  progressLabel: string,
  removePath: (path: string) => Promise<void>,
  record: OperationRecorder,
): Promise<number> {
  if (paths.length === 0) {
    console.log(`  ${statsLabel}: no remote files to remove`);
    return 0;
  }

  let removed = 0;
  const progressInterval = Math.max(1, Math.min(25, Math.floor(paths.length / 4)));
  for (const [index, path] of paths.entries()) {
    try {
      await removePath(path);
      await record({ operation: "delete-file", outcome: "succeeded", targets: [path] });
    } catch (error) {
      await record({ operation: "delete-file", outcome: "failed", targets: [path] });
      throw error;
    }
    removed++;
    const processed = index + 1;
    if (processed === paths.length || processed % progressInterval === 0) {
      logProgress(progressLabel, processed, paths.length);
    }
  }

  console.log(`  ${statsLabel}: ${removed} removed`);
  return removed;
}

async function buildLogSyncFile(
  dir: string,
  writer: (path: string, content: string) => Promise<number>,
): Promise<SyncableFile | null> {
  const logPath = join(dir, "log.md");
  try {
    const [logContent, logStats] = await Promise.all([
      readSafeFile(dir, logPath).then((bytes) => bytes.toString("utf-8")),
      lstat(logPath),
    ]);
    return {
      path: "/log.md",
      size: logStats.size,
      mtimeMs: logStats.mtimeMs,
      write: () => writer("/log.md", logContent),
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function performFullSync(
  client: ReturnType<typeof createClient>,
  dbId: string,
  dir: string,
  wikiEntries: WikiPageEntry[],
  sourceEntries: SourceFileEntry[],
  deletionPlan: DeletionPlan,
  state: SyncState | null,
  fileHashes: Record<string, string>,
  forceRewrite: boolean,
  record: OperationRecorder,
): Promise<{ created: number; updated: number; deleted: number; unchanged: number; referencedSourcePaths: Set<string>; pageSourceRows: PageSourceRow[]; hasLogFile: boolean }> {
  const wikiFiles = await Promise.all(wikiEntries.map(loadWikiPage));
  const sourceFiles = await Promise.all(sourceEntries.map(loadSourceFile));

  console.log("Loading remote wiki index...");
  const existing = await execSql(client, dbId, "SELECT slug, content_hash FROM wiki_index");
  const existingMap = new Map<string, string>();
  for (const row of existing.rows) {
    existingMap.set(row[0] as string, row[1] as string);
  }

  let created = 0;
  let updated = 0;
  let deleted = 0;
  let unchanged = 0;
  const pageSourceRows: PageSourceRow[] = [];
  const referencedSourcePaths = new Set<string>();

  for (const file of wikiFiles) {
    const { title, description, tags, sources } = parseFrontmatter(file.content);
    const pageTitle = title || file.slug;
    const pageDesc = description || "";
    const embText = escapeSqlLiteral(file.content.slice(0, 8000));

    for (const sourcePath of sources) {
      pageSourceRows.push({ pageSlug: file.slug, sourcePath });
      referencedSourcePaths.add(sourcePath);
    }

    if (!existingMap.has(file.slug)) {
      await execSql(client, dbId, `
        INSERT INTO wiki_index (slug, title, description, content_hash, content_vec, tags)
        VALUES (${escapeSqlLiteral(file.slug)}, ${escapeSqlLiteral(pageTitle)}, ${escapeSqlLiteral(pageDesc)},
                '${file.hash}', embedding(${embText})::vector(1024),
                ${escapeArray(tags)})
      `);
      created++;
    } else if (forceRewrite || existingMap.get(file.slug) !== file.hash) {
      await execSql(client, dbId, `
        UPDATE wiki_index
        SET title = ${escapeSqlLiteral(pageTitle)},
            description = ${escapeSqlLiteral(pageDesc)},
            content_hash = '${file.hash}',
            content_vec = embedding(${embText})::vector(1024),
            tags = ${escapeArray(tags)},
            updated_at = NOW()
        WHERE slug = ${escapeSqlLiteral(file.slug)}
      `);
      updated++;
    } else {
      unchanged++;
    }
  }

  for (const slug of deletionPlan.slugs) {
    await deleteSql(client, dbId, `DELETE FROM wiki_index WHERE slug = ${escapeSqlLiteral(slug)}`,
      [slug], "delete-index", record);
    deleted++;
  }
  console.log(`Wiki index diff complete: ${created} created, ${updated} updated, ${deleted} deleted, ${unchanged} unchanged.`);

  await syncPageSourceReferencesFull(client, dbId, pageSourceRows, record);

  console.log("Syncing to fs9...");
  const hasLogFile = await localLogExists(dir);
  try {
    const fsClient = await client.fs.connect(dbId);
    try {
      const wikiSyncFiles: SyncableFile[] = wikiFiles.map((file) => ({
        path: `/wiki/${file.path}`,
        size: file.size,
        mtimeMs: file.mtimeMs,
        forceWrite: forceRewrite || state?.fileHashes[`wiki/${file.path}`] !== fileHashes[`wiki/${file.path}`],
        write: () => fsClient.writeFile(`/wiki/${file.path}`, file.content),
      }));
      const sourceSyncFiles: SyncableFile[] = sourceFiles.map((file) => ({
        path: `/sources/${file.path}`,
        size: file.size,
        mtimeMs: file.mtimeMs,
        forceWrite: forceRewrite || state?.fileHashes[`sources/${file.path}`] !== fileHashes[`sources/${file.path}`],
        write: () => fsClient.writeFile(`/sources/${file.path}`, file.bytes),
      }));
      const logSyncFile = await buildLogSyncFile(dir, (path, content) => fsClient.writeFile(path, content));
      if (logSyncFile) logSyncFile.forceWrite = forceRewrite || state?.fileHashes["log.md"] !== fileHashes["log.md"];
      const wikiFs9 = await syncFs9Files(wikiSyncFiles, "wiki files", "wiki files", (path) => fsClient.stat(path));
      const sourceFs9 = await syncFs9Files(sourceSyncFiles, "source files", "source files", (path) => fsClient.stat(path));
      const logFs9 = logSyncFile
        ? await syncFs9Files([logSyncFile], "log file", "log file", (path) => fsClient.stat(path))
        : { written: 0, skipped: 0 };
      const removedFs9 = await removeFs9Paths(deletionPlan.paths, "stale remote files", "stale remote files",
        (path) => fsClient.rm(path, false), record);

      console.log(
        `  fs9 sync complete (${wikiFs9.written + sourceFs9.written + logFs9.written} written, ${wikiFs9.skipped + sourceFs9.skipped + logFs9.skipped} skipped, ${removedFs9} removed)`,
      );
    } finally {
      await fsClient.close();
    }
  } catch {
    throw new Error("File sync failed; local sync state was not advanced. Retry sync after resolving the error.");
  }

  return { created, updated, deleted, unchanged, referencedSourcePaths, pageSourceRows, hasLogFile };
}

async function performLightweightSync(
  client: ReturnType<typeof createClient>,
  dbId: string,
  dir: string,
  state: SyncState,
  wikiEntries: WikiPageEntry[],
  sourceEntries: SourceFileEntry[],
  deletionPlan: DeletionPlan,
  fileHashes: Record<string, string>,
  record: OperationRecorder,
): Promise<{ created: number; updated: number; deleted: number; unchanged: number; referencedSourcePaths: Set<string>; pageSourceRows: PageSourceRow[]; hasLogFile: boolean }> {
  const changedWikiEntries = wikiEntries.filter((entry) => state.fileHashes[`wiki/${entry.path}`] !== fileHashes[`wiki/${entry.path}`]);
  const changedSourceEntries = sourceEntries.filter((entry) => state.fileHashes[`sources/${entry.path}`] !== fileHashes[`sources/${entry.path}`]);
  const deletedWikiSlugs = deletionPlan.slugs;
  const deletedSourcePaths = deletionPlan.paths.filter((path) => path.startsWith("/sources/"));

  console.log(
    `Using lightweight sync since ${state.lastSuccessfulSyncAt} (${changedWikiEntries.length} wiki pages changed, ${changedSourceEntries.length} source files changed, ${deletedWikiSlugs.length} wiki pages deleted, ${deletedSourcePaths.length} source files deleted).`,
  );

  const changedWikiFiles = await Promise.all(changedWikiEntries.map(loadWikiPage));
  const changedSourceFiles = await Promise.all(changedSourceEntries.map(loadSourceFile));
  const referencedSourcePaths = new Set<string>();
  const pageSourceRows: PageSourceRow[] = [];

  let created = 0;
  let updated = 0;
  let deleted = 0;

  const affectedSlugs = Array.from(new Set([
    ...changedWikiFiles.map((file) => file.slug),
    ...deletedWikiSlugs,
  ]));

  let existingMap = new Map<string, string>();
  if (affectedSlugs.length > 0) {
    console.log("Loading affected remote wiki index rows...");
    const existing = await execSql(
      client,
      dbId,
      `SELECT slug, content_hash FROM wiki_index WHERE slug IN (${escapeSqlList(affectedSlugs)})`,
    );
    existingMap = new Map(existing.rows.map((row) => [row[0] as string, row[1] as string]));
  }

  for (const file of changedWikiFiles) {
    const { title, description, tags, sources } = parseFrontmatter(file.content);
    const pageTitle = title || file.slug;
    const pageDesc = description || "";
    const embText = escapeSqlLiteral(file.content.slice(0, 8000));

    for (const sourcePath of sources) {
      pageSourceRows.push({ pageSlug: file.slug, sourcePath });
      referencedSourcePaths.add(sourcePath);
    }

    if (!existingMap.has(file.slug)) {
      await execSql(client, dbId, `
        INSERT INTO wiki_index (slug, title, description, content_hash, content_vec, tags)
        VALUES (${escapeSqlLiteral(file.slug)}, ${escapeSqlLiteral(pageTitle)}, ${escapeSqlLiteral(pageDesc)},
                '${file.hash}', embedding(${embText})::vector(1024),
                ${escapeArray(tags)})
      `);
      created++;
    } else if (existingMap.get(file.slug) !== file.hash) {
      await execSql(client, dbId, `
        UPDATE wiki_index
        SET title = ${escapeSqlLiteral(pageTitle)},
            description = ${escapeSqlLiteral(pageDesc)},
            content_hash = '${file.hash}',
            content_vec = embedding(${embText})::vector(1024),
            tags = ${escapeArray(tags)},
            updated_at = NOW()
        WHERE slug = ${escapeSqlLiteral(file.slug)}
      `);
      updated++;
    }
  }

  if (deletedWikiSlugs.length > 0) {
    await deleteSql(client, dbId, `DELETE FROM wiki_index WHERE slug IN (${escapeSqlList(deletedWikiSlugs)})`,
      deletedWikiSlugs, "delete-index", record);
    deleted = deletedWikiSlugs.length;
  }
  const unchanged = wikiEntries.length - created - updated;
  console.log(`Wiki index diff complete: ${created} created, ${updated} updated, ${deleted} deleted, ${unchanged} unchanged.`);

  await syncPageSourceReferencesLightweight(client, dbId, pageSourceRows, affectedSlugs, record);

  console.log("Syncing to fs9...");
  const hasLogFile = await localLogExists(dir);
  try {
    const fsClient = await client.fs.connect(dbId);
    try {
      const wikiSyncFiles: SyncableFile[] = changedWikiFiles.map((file) => ({
        path: `/wiki/${file.path}`,
        size: file.size,
        mtimeMs: file.mtimeMs,
        write: () => fsClient.writeFile(`/wiki/${file.path}`, file.content),
      }));
      const sourceSyncFiles: SyncableFile[] = changedSourceFiles.map((file) => ({
        path: `/sources/${file.path}`,
        size: file.size,
        mtimeMs: file.mtimeMs,
        write: () => fsClient.writeFile(`/sources/${file.path}`, file.bytes),
      }));
      const actualLogSyncFile = await buildLogSyncFile(dir, (path, content) => fsClient.writeFile(path, content));
      const changedLogSyncFile = actualLogSyncFile && state.fileHashes["log.md"] !== fileHashes["log.md"]
        ? [actualLogSyncFile]
        : [];

      const wikiFs9 = await syncFs9Files(wikiSyncFiles, "wiki files", "wiki files");
      const sourceFs9 = await syncFs9Files(sourceSyncFiles, "source files", "source files");
      const logFs9 = await syncFs9Files(changedLogSyncFile, "log file", "log file");
      const removedFs9 = await removeFs9Paths(deletionPlan.paths, "deleted local files", "deleted local files",
        (path) => fsClient.rm(path, false), record);

      console.log(
        `  fs9 sync complete (${wikiFs9.written + sourceFs9.written + logFs9.written} written, ${wikiFs9.skipped + sourceFs9.skipped + logFs9.skipped} skipped, ${removedFs9} removed)`,
      );
    } finally {
      await fsClient.close();
    }
  } catch {
    throw new Error("File sync failed; local sync state was not advanced. Retry sync after resolving the error.");
  }

  return { created, updated, deleted, unchanged, referencedSourcePaths, pageSourceRows, hasLogFile };
}

export async function syncCommand(options: SyncOptions = {}) {
  if (options.prune && !options.full) throw new Error("--prune requires --full");
  const config = await loadConfig();
  const record = operationRecorder(process.cwd(), config.db9.database);
  await record({ operation: "sync", outcome: "started" });
  try {
    await synchronize(options, config, record);
    await record({ operation: "sync", outcome: "succeeded" });
  } catch (error) {
    await record({ operation: "sync", outcome: "failed" });
    throw error;
  }
}

async function synchronize(
  options: SyncOptions, config: Awaited<ReturnType<typeof loadConfig>>, record: OperationRecorder,
) {
  const startedAt = new Date().toISOString();
  const client = createClient(config);
  const dbId = config.db9.database;
  const dir = process.cwd();

  console.log("Scanning local files...");
  try {
    await lstat(join(dir, SYNC_STATE_DIR, "restore-incomplete"));
    throw new Error("Remote restore is incomplete. Retry `wiki9 init` before syncing.");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const wikiDir = join(dir, "wiki");
  const wikiEntries = await collectWikiPageEntries(wikiDir);
  const sourcesDir = join(dir, "sources");
  const sourceEntries = await collectSourceFileEntries(sourcesDir);
  const hasLogFile = await localLogExists(dir);
  console.log(`Collected ${wikiEntries.length} wiki pages and ${sourceEntries.length} source files.`);
  const fileHashes = await collectLocalHashes(dir, wikiEntries, sourceEntries, hasLogFile);

  const state = await loadSyncState(dir, dbId);
  await record({ operation: "schema", outcome: "started" });
  try {
    await initSchema(client, dbId);
  } catch (error) {
    await record({ operation: "schema", outcome: "failed" });
    throw error;
  }
  await record({ operation: "schema", outcome: "succeeded" });
  const remote = await inspectRemote(client, dbId);
  const snapshot = state?.version === 2 ? remote.legacySnapshot : remote.snapshot;
  if (state && snapshot !== state.remoteSnapshot && !options.prune) {
    throw new Error("Remote data changed since this directory last synced. Restore and merge changes in a separate directory before syncing, or explicitly review `wiki9 sync --full --prune` to replace remote data.");
  }
  const deletionPlan = requirePruneApproval(remote, state, wikiEntries, sourceEntries, hasLogFile, !!options.prune);
  const targets = [...deletionPlan.slugs.map((slug) => `index: ${slug}`), ...deletionPlan.paths];
  if (targets.length > 0) {
    console.log(`Remote deletion plan (${targets.length} targets):`);
    for (const target of targets) console.log(`  ${displayText(target)}`);
    await record({ operation: "sync", outcome: "planned", targets });
  }
  let result;
  if (options.full) {
    console.log("Running full sync...");
    if (options.prune) console.log("Explicit rebuild: replacing remote index entries, vectors and files with local content.");
    result = await performFullSync(client, dbId, dir, wikiEntries, sourceEntries,
      deletionPlan, state, fileHashes, !!options.prune, record);
  } else {
    if (!state) {
      console.log("No previous successful sync state found; running full sync without implicit remote pruning.");
      result = await performFullSync(client, dbId, dir, wikiEntries, sourceEntries,
        deletionPlan, state, fileHashes, false, record);
    } else {
      result = await performLightweightSync(client, dbId, dir, state, wikiEntries, sourceEntries,
        deletionPlan, fileHashes, record);
    }
  }

  const after = await inspectRemote(client, dbId);
  await saveSyncState(dir, wikiEntries, sourceEntries, result.hasLogFile, dbId, startedAt, after.snapshot, fileHashes);
  console.log(`Saved sync state to ${displayText(syncStatePath(dir))}.`);

  console.log("\nSync complete:");
  console.log(`  wiki:    ${result.created} created, ${result.updated} updated, ${result.deleted} deleted, ${result.unchanged} unchanged`);
  console.log(`  sources: ${sourceEntries.length} files synced, ${result.referencedSourcePaths.size} referenced, ${result.pageSourceRows.length} page-source links`);
}
