import { createHash } from "node:crypto";
import { openSafeFile } from "./paths.js";

export function contentHash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function fileHash(root: string, path: string): Promise<string> {
  const file = await openSafeFile(root, path);
  try {
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}
