import { describe, expect, it, vi } from "vitest";
import { execSql, initSchema } from "../src/db.js";

describe("backend error redaction", () => {
  it("retains SQLSTATE but omits backend messages, details and nested credentials", async () => {
    const sql = vi.fn(async () => ({
      error: { code: "42501", message: "SECRET token", details: { token: "SECRET" } },
    }));
    const failure = execSql({ databases: { sql } } as never, "test-db", "SELECT 1");
    await expect(failure).rejects.toThrow("SQL request failed (code 42501)");
    await expect(failure).rejects.not.toThrow("SECRET");
  });

  it("redacts thrown transport errors and their causes", async () => {
    const sql = vi.fn(async () => {
      throw Object.assign(new Error("Bearer SECRET"), { status: 403, cause: { token: "SECRET" } });
    });
    try {
      await execSql({ databases: { sql } } as never, "test-db", "SELECT 1");
      expect.fail("expected the request to fail");
    } catch (error) {
      expect(String(error)).toBe("Error: SQL request failed (HTTP 403)");
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("redacts schema response errors", async () => {
    const sql = vi.fn(async () => ({ error: { message: "SECRET query", code: "42P01" } }));
    await expect(initSchema({ databases: { sql } } as never, "test-db"))
      .rejects.toThrow("Schema init failed (code 42P01)");
  });

  it("redacts schema transport failures", async () => {
    const sql = vi.fn(async () => { throw new Error("SECRET credentials"); });
    await expect(initSchema({ databases: { sql } } as never, "test-db"))
      .rejects.toThrow("Schema init failed");
    await expect(initSchema({ databases: { sql } } as never, "test-db"))
      .rejects.not.toThrow("SECRET");
  });
});
