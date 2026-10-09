/**
 * Parses a CLI-supplied config value: JSON first (numbers, booleans, null,
 * arrays, objects), falling back to the raw string. `string: true` forces a
 * string (e.g. an engine command named `123`).
 */
export function parseConfigValue(text: string, options: { string?: boolean } = {}): unknown {
  if (options.string) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
