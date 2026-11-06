export interface OutputOptions {
  json?: boolean;
}

export function displayText(value: unknown, limit = 500): string {
  const escaped = String(value).replace(
    /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => {
      if (character === "\n") return "\\n";
      if (character === "\r") return "\\r";
      if (character === "\t") return "\\t";
      return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    },
  );
  return escaped.length > limit ? `${escaped.slice(0, limit)}…` : escaped;
}

export function markdownText(value: string): string {
  return displayText(value, Number.MAX_SAFE_INTEGER).replace(/[\\`*_{}[\]()#+.!|<>~&]/g, "\\$&");
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  ));
}
