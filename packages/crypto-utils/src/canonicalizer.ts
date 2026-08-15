/**
 * Recursively canonicalizes an object or value into a deterministic JSON string
 * with lexicographically sorted keys.
 */
export function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    const elements = obj.map((item) => canonicalize(item));
    return `[${elements.join(",")}]`;
  }

  const record = obj as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const entries = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`,
  );

  return `{${entries.join(",")}}`;
}
