class BackendError extends Error {}

export function isBackendError(error: unknown): error is Error {
  return error instanceof BackendError;
}

export function backendError(context: string, error: unknown): Error {
  const details = error && typeof error === "object"
    ? error as { code?: unknown; status?: unknown; sqlstate?: unknown }
    : {};
  const code = details.sqlstate ?? details.code;
  const state = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
    ? ` (code ${code})`
    : "";
  const status = typeof details.status === "number" && Number.isInteger(details.status)
    && details.status >= 400 && details.status <= 599
    ? ` (HTTP ${details.status})`
    : "";
  return new BackendError(`${context}${state}${status}`);
}
