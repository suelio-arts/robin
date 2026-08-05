type ContractSearchGit = {
  searchPaths(owner: string, repo: string, query: string): Promise<string[]>;
  getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string>;
};

const MAX_QUERIES = 4;
const MAX_PATHS_PER_QUERY = 4;
const MAX_PATHS = 10;
const FILE_LIMIT = 6000;
const TOTAL_LIMIT = 30000;

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

export async function buildContractSearchEvidence(
  git: ContractSearchGit,
  owner: string,
  repo: string,
  head: string,
  queries: string[]
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
      const limit = Math.min(FILE_LIMIT, remaining);
      const marker = "\n[... middle omitted ...]\n";
      const available = limit - marker.length;
      const excerpt = content.length <= limit
        ? content
        : available > 0
          ? `${content.slice(0, Math.floor(available * 0.75))}${marker}${content.slice(-Math.ceil(available * 0.25))}`
          : content.slice(0, limit);
      sections.push(`HEAD CONTRACT SEARCH MATCH (${query}): ${path}\n${excerpt}`);
      remaining -= excerpt.length;
    }
  }
  return sections.join("\n\n");
}

export function wrapContractSearchEvidence(evidence: string): string {
  return `<contract-search-evidence>\n${evidence || "No repository search matches were available."}\n</contract-search-evidence>`;
}
