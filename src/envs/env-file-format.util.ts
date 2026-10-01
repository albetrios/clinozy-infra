/**
 * Encode a value for a `.env` file so dotenv reads it back identically.
 */
export function escapeEnvValue(value: string): string {
  if (value === '') return '';
  if (value.includes('\n') || value.includes('\r')) {
    if (value.includes("'")) {
      const doubled = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `"${doubled}"`;
    }
    return `'${value}'`;
  }
  const hasSpecial = /[\s#"'\\]/.test(value);
  if (!hasSpecial) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
