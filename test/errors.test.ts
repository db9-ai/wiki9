import { describe, expect, it, vi } from "vitest";
import { execSql, initSchema } from "../src/db.js";
import { backendError, isBackendError } from "../src/utils/errors.js";

describe("backend error redaction", () => {
  it("identifies only internally redacted errors without changing their Error presentation", () => {
    const error = backendError("Schema init failed", {
      code: "42501", status: 403, message: "SECRET", details: "SECRET", cause: new Error("SECRET"),
    });
    expect(isBackendError(error)).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("Error");
    expect(String(error)).toBe("Error: Schema init failed (code 42501) (HTTP 403)");
    expect(error.cause).toBeUndefined();
    expect(Object.keys(error)).toEqual([]);
    expect(isBackendError(new Error("Schema init failed (code 42501)"))).toBe(false);
    expect(isBackendError(Object.assign(new Error("SECRET"), { name: "BackendError" }))).toBe(false);
    expect(isBackendError({ name: "BackendError", message: error.message })).toBe(false);
    expect(isBackendError(null)).toBe(false);
  });

  it.each([
    { code: "42501 SECRET", status: 399 },
    { sqlstate: "\u001b[31m", code: "42501", status: 600 },
    { code: "abcde", status: 403.5 },
    { code: 42501, status: "403" },
    null,
  ])("does not expand the accepted backend fields for %j", (details) => {
    const error = backendError("Schema init failed", details);
    expect(isBackendError(error)).toBe(true);
    expect(error.message).toBe("Schema init failed");
    expect(error.cause).toBeUndefined();
  });

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

describe("index initialization", () => {
  it("completes both index requests on repeated initialization", async () => {
    const sql = vi.fn().mockResolvedValue({ error: null });
    const client = { databases: { sql } } as never;
    await initSchema(client, "test-db");
    await initSchema(client, "test-db");
    expect(sql).toHaveBeenCalledTimes(6);
  });

  it.each([
    [1, "42501"],
    [2, "42501"],
    [1, "42601"],
    [2, "42601"],
    [1, "42P07"],
    [2, "42P07"],
  ])("rejects response errors at request %i with code %s", async (failedRequest, code) => {
    const sql = vi.fn().mockResolvedValue({ error: null });
    for (let request = 0; request < failedRequest; request++) {
      sql.mockResolvedValueOnce({ error: null });
    }
    sql.mockResolvedValueOnce({
      error: { code, message: "SECRET SQL and credentials", details: { token: "SECRET" } },
    });
    const failure = initSchema({ databases: { sql } } as never, "test-db");
    await expect(failure).rejects.toThrow(`Index initialization failed (code ${code})`);
    await expect(failure).rejects.not.toThrow("SECRET");
    expect(sql).toHaveBeenCalledTimes(failedRequest + 1);
  });

  it.each([1, 2])("redacts transport errors at index request %i", async (failedRequest) => {
    const sql = vi.fn().mockResolvedValue({ error: null });
    for (let request = 0; request < failedRequest; request++) {
      sql.mockResolvedValueOnce({ error: null });
    }
    sql.mockRejectedValueOnce(Object.assign(
      new Error("Bearer SECRET"),
      { status: 403, cause: { token: "SECRET" } },
    ));
    try {
      await initSchema({ databases: { sql } } as never, "test-db");
      expect.fail("expected index initialization to fail");
    } catch (error) {
      expect(String(error)).toBe("Error: Index initialization failed (HTTP 403)");
      expect((error as Error).cause).toBeUndefined();
    }
    expect(sql).toHaveBeenCalledTimes(failedRequest + 1);
  });
});
