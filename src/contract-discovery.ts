type ContractSearchGit = {
  searchPaths(owner: string, repo: string, query: string): Promise<string[]>;
  getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string>;
};

const MAX_QUERIES = 4;
const MAX_PATHS_PER_QUERY = 4;
const MAX_PATHS = 10;
const FILE_LIMIT = 6000;
const TOTAL_LIMIT = 30000;

function excerptMatches(content: string, query: string, limit: number): string {
  if (content.length <= limit) return content;
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const separator = "\n[... omitted ...]\n";
  const maxWindows = Math.max(1, Math.floor((limit + separator.length) / (separator.length + 1)));
  const matches: RegExpMatchArray[] = [];
  for (const match of content.matchAll(pattern)) {
    matches.push(match);
    if (matches.length === Math.min(4, maxWindows)) break;
  }
  if (matches.length === 0) return content.slice(0, limit);
  const windowSize = Math.floor((limit - separator.length * (matches.length - 1)) / matches.length);
  return matches.map(({index = 0}) => {
    const start = Math.max(0, Math.min(index - Math.floor(windowSize / 2), content.length - windowSize));
    return content.slice(start, start + windowSize);
  }).join(separator);
}

export function parseContractSearchPlan(content: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return [];
  }
  const queries = (value as {queries?: unknown})?.queries;
  if (!Array.isArray(queries)) return [];
  return [...new Set(queries
    .filter((query): query is string => typeof query === "string")
    .map((query) => query.trim())
    .filter((query) => query.length >= 2 && query.length <= 80)
    .filter((query) => !/\b[A-Za-z][A-Za-z0-9_-]*:/.test(query))
    .filter((query) => /^[A-Za-z0-9_$./@+ -]+$/.test(query))
  )].slice(0, MAX_QUERIES);
}

export function completeContractSearchPlan(content: string, chunk: string): string[] {
  const planned = parseContractSearchPlan(content);
  const projectionQueries = /^diff --git a\/[^ ]*(?:studio|editor|simulator)[^ ]* /mi.test(chunk) && /^\+\s*title\s*:/m.test(chunk)
    ? ["OverridesById", "buildStoryWalk"]
    : [];
  return [...new Set([...projectionQueries, ...planned])].slice(0, MAX_QUERIES);
}

export function changedHeadPaths(diff: string): string[] {
  return [...diff.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)].map((match) => match[1]);
}

export async function buildContractSearchEvidence(
  git: ContractSearchGit,
  owner: string,
  repo: string,
  head: string,
  queries: string[],
  changedPaths: string[] = []
): Promise<string> {
  const seen = new Set<string>();
  const sections: string[] = [];
  let remaining = TOTAL_LIMIT;
  for (const query of queries.slice(0, MAX_QUERIES)) {
    let paths: string[];
    try {
      paths = await git.searchPaths(owner, repo, query);
    } catch {
      continue;
    }
    paths.sort((left, right) => contractPathAffinity(right, changedPaths) - contractPathAffinity(left, changedPaths) || left.localeCompare(right));
    for (const path of paths.slice(0, MAX_PATHS_PER_QUERY)) {
      if (seen.has(path) || seen.size >= MAX_PATHS || remaining <= 0) continue;
      seen.add(path);
      let content: string;
      try {
        content = await git.getFileContent(owner, repo, path, head);
      } catch {
        continue;
      }
      if (!content) continue;
      const header = `HEAD CONTRACT SEARCH MATCH (${query}): ${path}\n`;
      const framing = header.length + (sections.length ? 2 : 0);
      const limit = Math.min(FILE_LIMIT, remaining - framing);
      if (limit <= 0) continue;
      const excerpt = excerptMatches(content, query, limit);
      sections.push(`${header}${excerpt}`);
      remaining -= framing + excerpt.length;
    }
  }
  return sections.join("\n\n");
}

function contractPathAffinity(path: string, changedPaths: string[]): number {
  const tokens = new Set(path.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4));
  return Math.max(0, ...changedPaths.map((changed) => {
    const changedTokens = changed.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
    const tokenMatches = changedTokens.filter((token) => tokens.has(token)).length;
    const left = path.split("/");
    const right = changed.split("/");
    let shared = 0;
    while (left[shared] && left[shared] === right[shared]) shared += 1;
    return tokenMatches * 100 + shared;
  }));
}

export function wrapContractSearchEvidence(evidence: string): string {
  return `<contract-search-evidence>\n${evidence || "No repository search matches were available."}\n</contract-search-evidence>`;
}
