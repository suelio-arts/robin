import { splitDiffIntoFiles } from "./diff-filter";
import { GitUtils } from "./git-utils";
import { posix } from "path";
import { isIP } from "net";

const CONTEXT_LIMIT = 50000;
const FILE_LIMIT = 20000;
const RELATED_LIMIT = 12000;
const RELATED_REQUEST_LIMIT = 24;
type ReviewContextGit = Pick<GitUtils, "getFileContent" | "getTreePaths" | "searchPaths">;

function excerpt(content: string, limit: number): string {
  if (content.length <= limit) return content;
  return `${content.slice(0, Math.floor(limit * 0.75))}\n[... middle omitted ...]\n${content.slice(-Math.floor(limit * 0.25))}`;
}

export async function buildFileContext(
  git: ReviewContextGit,
  owner: string,
  repo: string,
  chunk: string,
  base: string,
  head: string
): Promise<string> {
  let remaining = CONTEXT_LIMIT;
  const sections: string[] = [];
  const fetched = new Set<string>();
  const terms = changedIdentifiers(chunk);
  const changedPaths = splitDiffIntoFiles(chunk).map((file) => file.path);
  const relatedBudget = { remaining: RELATED_REQUEST_LIMIT };

  for (const file of splitDiffIntoFiles(chunk)) {
    const prior = file.path.replace(/-v(\d+)(?=\.[^.]+$)/, (_, value) => `-v${Number(value) - 1}`);
    const sources: Array<[string, string, string]> = [
      ["HEAD", head, file.path],
      ["BASE", base, file.path],
    ];
    if (prior !== file.path) sources.push(["BASE PREVIOUS VERSION", base, prior]);

    for (const [label, ref, path] of sources) {
      if (remaining <= 0) return sections.join("\n\n");
      const content = await git.getFileContent(owner, repo, path, ref);
      if (!content) continue;
      fetched.add(`${ref}:${path}`);
      const valueLimit = Math.min(FILE_LIMIT, remaining);
      const value = label === "HEAD" && content.length > valueLimit
        ? matchingNeighborhoods(content, terms, valueLimit) || excerpt(content, valueLimit)
        : excerpt(content, valueLimit);
      sections.push(`${label} FILE: ${path}\n${value}`);
      remaining -= value.length;

      if (label === "HEAD" && remaining > 0) {
        for (const relatedPath of relativeImports(content, path)) {
          const related = await resolveRelatedFile(git, owner, repo, relatedPath, head, fetched, relatedBudget);
          if (!related) continue;
          const focused = matchingNeighborhoods(related.content, terms, Math.min(RELATED_LIMIT, remaining));
          if (!focused) continue;
          sections.push(`HEAD RELATED FILE: ${related.path}\n${focused}`);
          remaining -= focused.length;
          if (remaining <= 0) break;
        }
      }
    }
  }

  if (remaining > 0) {
    const paths = await git.getTreePaths(owner, repo, head);
    const conventions = paths
      .filter((path) => /(?:^|[-_./])(registry|schema|schemas|contract|contracts|manifest)(?:[-_./]|$)/i.test(path))
      .sort((left, right) => pathAffinity(right, changedPaths) - pathAffinity(left, changedPaths) || left.localeCompare(right));
    for (const path of conventions.slice(0, 12)) {
      const key = `${head}:${path}`;
      if (fetched.has(key)) continue;
      fetched.add(key);
      const content = await git.getFileContent(owner, repo, path, head);
      if (!content) continue;
      const focused = matchingNeighborhoods(content, terms, Math.min(RELATED_LIMIT, remaining));
      if (!focused) continue;
      sections.push(`HEAD CONVENTION FILE: ${path}\n${focused}`);
      remaining -= focused.length;
      if (remaining <= 0) break;
    }
  }

  if (remaining > 0) {
    const paths = [...new Set((await Promise.all(
      terms.slice(0, 6).map((term) => git.searchPaths(owner, repo, term))
    )).flat())].filter((path) => !changedPaths.includes(path));
    for (const path of paths.slice(0, 12)) {
      const key = `${head}:${path}`;
      if (fetched.has(key)) continue;
      fetched.add(key);
      const content = await git.getFileContent(owner, repo, path, head);
      if (!content) continue;
      const focused = matchingNeighborhoods(content, terms, Math.min(RELATED_LIMIT, remaining));
      if (!focused) continue;
      sections.push(`HEAD REPOSITORY SEARCH MATCH: ${path}\n${focused}`);
      remaining -= focused.length;
      if (remaining <= 0) break;
    }
  }


  return sections.join("\n\n");
}

export function publicContractSubjects(diff: string): string[] {
  const subjects = new Set<string>();
  for (const match of diff.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try {
      const url = new URL(match[0]);
      if (!url.username && !url.password && isPublicHostname(url.hostname)) subjects.add(url.hostname);
    } catch {
      // Ignore malformed literals.
    }
  }
  for (const match of diff.matchAll(/\/usr\/bin\/([A-Za-z0-9._+-]+)/g)) subjects.add(`system command ${match[1]}`);
  return [...subjects].slice(0, 12);
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(host) === 4) return isPublicIPv4(host);
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return isPublicIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  if (isIP(host) === 6) return host !== "::1" && !host.startsWith("fc") && !host.startsWith("fd") && !host.startsWith("fe8") && !host.startsWith("fe9") && !host.startsWith("fea") && !host.startsWith("feb");
  return host !== "localhost" && host.includes(".") && !/\.(?:internal|local|localhost|test|example|invalid)$/.test(host);
}

function isPublicIPv4(host: string): boolean {
  const [a, b] = host.split(".").map(Number);
  return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
}

function pathAffinity(path: string, changedPaths: string[]): number {
  return Math.max(0, ...changedPaths.map((changed) => {
    const left = path.split("/");
    const right = changed.split("/");
    let shared = 0;
    while (left[shared] && left[shared] === right[shared]) shared += 1;
    return shared;
  }));
}

function changedIdentifiers(diff: string): string[] {
  const counts = new Map<string, number>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const term of line.match(/[A-Za-z_$][A-Za-z0-9_$]{4,}/g) || []) {
      if (/^(const|return|function|async|await|false|true|undefined|interface|import|from)$/.test(term)) continue;
      counts.set(term, (counts.get(term) || 0) + 1);
    }
  }
  const ordered = [...counts.entries()]
    .sort((left, right) => right[0].length - left[0].length || right[1] - left[1])
    .map(([term]) => term);
  const expanded = new Set<string>();
  for (const term of ordered) {
    expanded.add(term);
    const boundaries = [...term.matchAll(/[A-Z]/g)].map((match) => match.index || 0).filter((index) => index > 0);
    for (const index of boundaries) {
      const suffix = term.slice(index);
      if (suffix.length >= 7) expanded.add(suffix[0].toLowerCase() + suffix.slice(1));
    }
  }
  return [...expanded].slice(0, 50);
}

function relativeImports(content: string, sourcePath: string): string[] {
  const paths = new Set<string>();
  const pattern = /(?:from\s+|require\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
  for (const match of content.matchAll(pattern)) {
    paths.add(posix.normalize(posix.join(posix.dirname(sourcePath), match[1])));
  }
  return [...paths].slice(0, 12);
}

async function resolveRelatedFile(
  git: ReviewContextGit,
  owner: string,
  repo: string,
  importPath: string,
  head: string,
  fetched: Set<string>,
  budget: { remaining: number }
): Promise<{ path: string; content: string } | undefined> {
  const candidates = posix.extname(importPath)
    ? [importPath]
    : [importPath + ".ts", importPath + ".tsx", importPath + ".js", importPath + ".mjs", posix.join(importPath, "index.ts")];
  const pending = [];
  for (const path of candidates) {
    if (budget.remaining <= 0) break;
    const key = `${head}:${path}`;
    if (fetched.has(key)) continue;
    fetched.add(key);
    budget.remaining -= 1;
    pending.push(git.getFileContent(owner, repo, path, head).then((content) => ({ path, content })));
  }
  return (await Promise.all(pending)).find(({ content }) => content) || undefined;
}

function matchingNeighborhoods(content: string, terms: string[], limit: number): string {
  if (terms.length === 0) return "";
  const lines = content.split("\n");
  const selected = new Set<number>();
  let selectedLength = 0;
  const matches = lines
    .map((line, index) => ({
      index,
      score: Math.max(0, ...terms.map((term, termIndex) => line.includes(term) ? terms.length - termIndex : 0)),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  for (const { index } of matches) {
    for (let nearby = Math.max(0, index - 3); nearby <= Math.min(lines.length - 1, index + 3); nearby += 1) {
      if (selected.has(nearby)) continue;
      const lineLength = String(nearby + 1).length + 2 + lines[nearby].length + 1;
      if (selectedLength + lineLength > limit) continue;
      selected.add(nearby);
      selectedLength += lineLength;
    }
    if (selectedLength >= limit) break;
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => `${index + 1}: ${lines[index]}`)
    .join("\n");
}
