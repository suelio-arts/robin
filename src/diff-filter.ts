import { changedHeadPaths } from "./contract-discovery";

export const DEFAULT_SKIP_PATH_PATTERNS = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/Cargo.lock",
  "**/Gemfile.lock",
  "**/poetry.lock",
  "**/*.min.js",
  "**/*.min.css",
  "**/dist/**",
  "**/node_modules/**",
];

export function matchPathPattern(pattern: string, filePath: string): boolean {
  const normalized = filePath.replace(/^\.\//, "");

  if (pattern.startsWith("**/") && pattern.endsWith("/**")) {
    const segment = pattern.slice(3, -3);
    return normalized === segment || normalized.startsWith(`${segment}/`) || normalized.includes(`/${segment}/`);
  }

  if (pattern.startsWith("**/") && !pattern.slice(3).includes("*")) {
    const suffix = pattern.slice(3);
    return normalized === suffix || normalized.endsWith(`/${suffix}`);
  }

  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  }

  if (pattern.includes("*")) {
    const regex = new RegExp(
      `^${pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\/\*\*\//g, "/(?:.*/)?")
        .replace(/\*\*\//g, "(?:.*/)?")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, "[^/]*")}$`
    );
    return regex.test(normalized);
  }

  return normalized === pattern || normalized.endsWith(`/${pattern}`);
}

export function shouldSkipPath(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchPathPattern(pattern, filePath));
}

export function splitDiffIntoFiles(diff: string): Array<{ path: string; content: string }> {
  const parts = diff.split(/^diff --git /m);
  const files: Array<{ path: string; content: string }> = [];

  for (const part of parts) {
    if (!part.trim()) continue;

    const headerLine = part.split("\n")[0] || "";
    const match = headerLine.match(/a\/(.+?) b\/(.+)$/);
    const path = match ? match[2] : headerLine;
    files.push({ path, content: `diff --git ${part}` });
  }

  return files;
}

export function selectDiffFiles(diff: string, selectedPaths: Set<string>): string {
  if (selectedPaths.size === 0) return diff;
  return splitDiffIntoFiles(diff)
    .filter(({content}) => changedHeadPaths(content).some((path) => selectedPaths.has(path)))
    .map(({content}) => content)
    .join("");
}

export function filterDiff(
  diff: string,
  extraSkipPatterns: string[] = []
): { filtered: string; removedFiles: string[] } {
  const patterns = [...DEFAULT_SKIP_PATH_PATTERNS, ...extraSkipPatterns];
  const files = splitDiffIntoFiles(diff);
  const removedFiles: string[] = [];
  const kept: string[] = [];

  for (const file of files) {
    if (shouldSkipPath(file.path, patterns)) {
      removedFiles.push(file.path);
    } else {
      kept.push(file.content);
    }
  }

  return { filtered: kept.join(""), removedFiles };
}

export function chunkDiffByFile(diff: string, maxChunkSize: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const file of splitDiffIntoFiles(diff)) {
    if (current && current.length + file.content.length > maxChunkSize) {
      chunks.push(current);
      current = "";
    }
    if (file.content.length > maxChunkSize) {
      chunks.push(...chunkOversizedFile(file.content, maxChunkSize));
    } else {
      current += file.content;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function chunkOversizedFile(content: string, maxChunkSize: number): string[] {
  const firstHunk = content.search(/^@@ /m);
  const header = firstHunk === -1 ? "" : content.slice(0, firstHunk);
  const bodies = firstHunk === -1
    ? [content]
    : content.slice(firstHunk).split(/(?=^@@ )/m).filter(Boolean);
  if (header && maxChunkSize <= header.length) {
    throw new RangeError(`maxChunkSize must exceed the ${header.length}-character diff header`);
  }
  const prefix = header;
  const bodyLimit = Math.max(1, maxChunkSize - prefix.length);
  const pages: string[] = [];
  let page = prefix;

  const flush = () => {
    if (page.length > prefix.length || (prefix === "" && page)) pages.push(page);
    page = prefix;
  };

  for (const body of bodies) {
    if (body.length > bodyLimit) {
      flush();
      for (let offset = 0; offset < body.length; offset += bodyLimit) {
        pages.push(prefix + body.slice(offset, offset + bodyLimit));
      }
      continue;
    }
    if (page.length + body.length > maxChunkSize) flush();
    page += body;
  }
  flush();
  return pages;
}
