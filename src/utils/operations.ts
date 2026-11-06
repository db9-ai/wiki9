import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensureSafeDirectory } from "./paths.js";

interface Operation {
  operation: "init" | "sync" | "schema" | "credential-update" | "delete-index" | "delete-file" | "delete-references";
  outcome: "started" | "planned" | "succeeded" | "failed";
  targets?: string[];
  credentialSource?: "argument" | "environment" | "configuration" | "login";
}

export type OperationRecorder = (entry: Operation) => Promise<void>;

export function operationRecorder(root: string, database: string): OperationRecorder {
  const runId = randomUUID();
  return async (entry) => {
    try {
      const directory = join(root, ".wiki9");
      await ensureSafeDirectory(root, directory, true, 0o700);
      const file = await open(
        join(directory, "operations.jsonl"),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      );
      try {
        if (!(await file.stat()).isFile()) throw new Error("Operation record must be a regular file");
        await file.chmod(0o600);
        await file.writeFile(`${JSON.stringify({ at: new Date().toISOString(), runId, database, ...entry })}\n`);
      } finally {
        await file.close();
      }
    } catch {
      console.error("Warning: could not write the local operation record.");
    }
  };
}
