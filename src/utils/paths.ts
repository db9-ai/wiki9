import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export function isRelativeFilePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && !value.includes("\\") && !/[\x00-\x1f]/.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function remoteChildPath(parent: string, child: string): string {
  const prefix = `${parent}/`;
  const name = child.startsWith("/") ? child.slice(prefix.length) : child;
  if ((child.startsWith("/") && !child.startsWith(prefix))
    || !isRelativeFilePath(name) || name.includes("/")) {
    throw new Error(`Invalid remote directory entry under ${parent}`);
  }
  return `${prefix}${name}`;
}

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export async function ensureSafeDirectory(root: string, path: string, create = false): Promise<void> {
  const base = resolve(root);
  const rel = relative(base, resolve(path));
  if (rel && !isRelativeFilePath(rel)) throw new Error("Local path escapes project directory");
  const paths = [base];
  for (const part of rel ? rel.split("/") : []) paths.push(resolve(paths[paths.length - 1], part));
  for (const dir of paths) {
    if (create) {
      try {
        await mkdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe directory: ${dir}`);
  }
}

export async function readSafeFile(root: string, path: string): Promise<Buffer> {
  await ensureSafeDirectory(root, dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error(`Not a regular file: ${path}`);
    return await file.readFile();
  } finally {
    await file.close();
  }
}

export async function writeSafeFileIfMissing(
  root: string, path: string, content: string | Uint8Array, mode = 0o644,
): Promise<boolean> {
  await ensureSafeDirectory(root, dirname(path), true);
  try {
    const file = await open(path, "wx", mode);
    try {
      await file.writeFile(content);
    } finally {
      await file.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await lstat(path)).isFile()) throw new Error(`Unsafe existing file: ${path}`);
    return false;
  }
}
