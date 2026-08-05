type ContractSearchGit = {
  searchPaths(owner: string, repo: string, query: string): Promise<string[]>;
  getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string>;
};

const MAX_QUERIES = 4;
const MAX_PATHS_PER_QUERY = 5;
const MAX_PATHS = 10;
const FILE_LIMIT = 6000;
const TOTAL_LIMIT = 30000;

type QueryCandidate = {query: string; priority: number};

function addedLines(chunk: string): string[] {
  return chunk.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
}

/** Exact changed symbols and literals whose unchanged consumers define the contract. */
export function extractChangedContractQueries(chunk: string): string[] {
  const lines = addedLines(chunk);
  const candidates: QueryCandidate[] = [];
  const add = (query: string, priority: number) => {
    const value = query.trim();
    if (value.length >= 2 && value.length <= 80 && /^[A-Za-z0-9_$./@+ -]+$/.test(value)) {
      candidates.push({query: value, priority});
    }
  };

  for (const line of lines) {
    for (const match of line.matchAll(/\b(?:async\s+function\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)\s*(?:=\s*async\b|\()/g)) add(match[1], 100);
    for (const match of line.matchAll(/\b(?:setInterval|setTimeout|queueMicrotask)\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(match[1], 100);
    for (const match of line.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/g)) add(match[0], 90);

    if (/\b(?:import|require)\b/.test(line)) {
      for (const match of line.matchAll(/\b((?:is|has|can|should|validate|verify|assert|require|check)[A-Z_$][\w$]*)\b/g)) add(match[1], 85);
    }
    for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*(?:true|false|null|["'][A-Za-z][\w-]*["'])/g)) add(match[1], 75);
    for (const match of line.matchAll(/["'](\/[A-Za-z0-9_./:@+-]{2,})["']/g)) add(match[1], 80);
    if (/\b(?:exec|spawn|command|usage|preflight|aggregate)\b/i.test(line)) {
      for (const match of line.matchAll(/["'`]([A-Za-z0-9_./@+-]+(?: [A-Za-z0-9_./@+<>=-]+)+)["'`]/g)) add(match[1], 70);
    }
  }

  if (/^diff --git a\/[^ ]+\.py b\/[^ ]+\.py/m.test(chunk)) {
    add("ruff", 65);
    add("lint", 64);
  }
  return [...new Map(candidates
    .sort((left, right) => right.priority - left.priority || left.query.localeCompare(right.query))
    .map((candidate) => [candidate.query, candidate.query])).values()].slice(0, MAX_QUERIES);
}

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

export function completeContractSearchPlan(
  content: string,
  chunk: string,
  context = "",
  options: {prioritizePlanned?: boolean} = {}
): string[] {
  const planned = parseContractSearchPlan(content);
  const changedContractQueries = extractChangedContractQueries(chunk);
  const exactOverrideCollection = (chunk + "\n" + context).match(/\b[A-Za-z_$][\w$]*OverridesById\b/)?.[0];
  const projectionQueries = /^diff --git a\/[^ ]*(?:studio|editor|simulator)[^ ]* /mi.test(chunk) && /^\+.*\btitle\s*:/m.test(chunk)
    ? [exactOverrideCollection ?? "OverridesById", "buildStoryWalk"]
    : [];
  const requiredCollectionQueries = [...chunk.matchAll(/\b([A-Za-z_$][\w$]*)\s*&&\s*([A-Za-z_$][\w$]*)\.length\s*===?\s*0/g)]
    .flatMap((match) => [match[1], match[2]]);
  const helperQueries = [...chunk.matchAll(/\b((?:assemble|validate|verify|parse|normalize|serialize|deserialize|require|load|save|persist)[A-Za-z0-9_$]*)\s*\(/gi)]
    .map((match) => match[1]);
  const changedCliUsage = chunk.split("\n").find((line) => /^\+\s*\S*cli\b.*--/i.test(line)) || "";
  const documentedOptions = new Set([...changedCliUsage.matchAll(/--([a-z0-9-]+)/gi)].map((match) => match[1]));
  const missingCliOptions = [...new Set([...(chunk + "\n" + context).matchAll(/\boptions(?:\[['"]([^'"]+)['"]\]|\.([A-Za-z][\w-]*))/g)]
    .map((match) => match[1] || match[2])
    .filter((option) => changedCliUsage && !documentedOptions.has(option)))]
    .sort((left, right) => Number(right.includes("-")) - Number(left.includes("-")) || left.localeCompare(right));
  const checkoutRepo = chunk.split(/\n(?=\s*(?:[+-]\s*)?-\s+uses:)/)
    .find((step) => /^\+\s*ref:\s*[0-9a-f]{40}\s*$/m.test(step))
    ?.match(/\brepository:\s*[A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+)/)?.[1];
  const pinnedHeadQuery = checkoutRepo
    ? `${checkoutRepo.replace(/[-_.]+(.)/g, (_match, char: string) => char.toUpperCase())}Head`
    : undefined;
  const inferred = [...requiredCollectionQueries, ...projectionQueries, ...(pinnedHeadQuery ? [pinnedHeadQuery] : []), ...missingCliOptions, ...helperQueries];
  return [...new Set(options.prioritizePlanned
    ? [...planned, ...inferred, ...changedContractQueries]
    : [...inferred, ...planned, ...changedContractQueries])]
    .slice(0, MAX_QUERIES);
}

export function changedHeadPaths(diff: string): string[] {
  return diff.split("\n").flatMap((line) => {
    if (!line.startsWith("diff --git ")) return [];
    const fields = [...line.slice(11).matchAll(/"((?:\\.|[^"])*)"|(\S+)/g)];
    if (fields.length !== 2) return [];
    const quoted = fields[1][1];
    const value = quoted === undefined ? fields[1][2] : decodeGitQuotedPath(quoted);
    return value.startsWith("b/") ? [value.slice(2)] : [];
  });
}

function decodeGitQuotedPath(value: string): string {
  const bytes: number[] = [];
  const escapes: Record<string, number> = {a: 7, n: 10, r: 13, t: 9, b: 8, f: 12, v: 11};
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\") {
      bytes.push(...Buffer.from(value[index]));
      continue;
    }
    const octal = value.slice(index + 1, index + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
    } else {
      const escaped = value[++index];
      bytes.push(escapes[escaped] ?? escaped.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

export async function buildContractSearchEvidence(
  git: ContractSearchGit,
  owner: string,
  repo: string,
  head: string,
  queries: string[],
  changedPaths: string[] = [],
  options: {counterevidence?: boolean; reviewedPaths?: string[]} = {}
): Promise<string> {
  const seen = new Set<string>();
  const sections: string[] = [];
  let remaining = TOTAL_LIMIT;
  const expandedQueries: string[] = [];
  for (const query of queries.slice(0, MAX_QUERIES)) {
    let expanded = false;
    if (query === "OverridesById") {
      for (const path of [...new Set([...changedPaths, ...(options.reviewedPaths || [])])]) {
        try {
          const content = await git.getFileContent(owner, repo, path, head);
          const exact = content.match(/\b[A-Za-z_$][\w$]*OverridesById\b/)?.[0];
          if (exact) {
            expandedQueries.push(exact);
            expanded = true;
          }
        } catch {
          // Keep the broad planned query when exact-head context is unavailable.
        }
      }
    }
    if (!expanded) expandedQueries.push(query);
  }
  for (const query of [...new Set(expandedQueries)].slice(0, MAX_QUERIES)) {
    let paths: string[];
    try {
      paths = await git.searchPaths(owner, repo, query);
    } catch {
      paths = [];
    }
    const exactHeadPaths: string[] = [];
    for (const path of [...new Set([...changedPaths, ...(options.reviewedPaths || [])])].slice(0, 40)) {
      try {
        if ((await git.getFileContent(owner, repo, path, head)).includes(query)) exactHeadPaths.push(path);
      } catch {
        // Default-branch search evidence remains useful when an exact changed file is unavailable.
      }
    }
    paths = [...new Set([...exactHeadPaths, ...paths])];
    const relatedPaths = [...new Set([...changedPaths, ...(options.reviewedPaths || [])])];
    paths.sort((left, right) => contractPathScore(right, relatedPaths, options.counterevidence) - contractPathScore(left, relatedPaths, options.counterevidence) || left.localeCompare(right));
    const selectedPaths = options.counterevidence
      ? paths.slice(0, MAX_PATHS_PER_QUERY)
      : selectLayerDiversePaths(paths, MAX_PATHS_PER_QUERY, options.reviewedPaths, changedPaths);
    for (const path of selectedPaths) {
      if (seen.has(path) || seen.size >= MAX_PATHS || remaining <= 0) continue;
      seen.add(path);
      let content: string;
      try {
        content = await git.getFileContent(owner, repo, path, head);
      } catch {
        continue;
      }
      if (!content) continue;
      const changedMarker = options.reviewedPaths?.includes(path) ? " [CHANGED IN THIS PR]" : "";
      const header = `HEAD CONTRACT SEARCH MATCH (${query}): ${path}${changedMarker}\n`;
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

function contractLayer(path: string): string {
  if (path.startsWith(".github/")) return "workflow";
  if (/^(?:docs?\/|README)/i.test(path)) return "docs";
  if (/\.(?:swift|m|mm)$|(?:^|\/)ios(?:\/|$)/i.test(path)) return "apple";
  if (/(?:^|\/)(?:backend|server|api)(?:\/|$)/i.test(path)) return "server";
  if (/(?:^|[/_.-])(?:test|tests|spec|specs|e2e|fixture|fixtures)(?:[/_.-]|$)/i.test(path)) return "test";
  if (/(?:^|\/)(?:scripts?|cli|bin)(?:\/|$)/i.test(path)) return "tooling";
  if (/(?:^|\/)(?:web|studio|app)(?:\/|$)/i.test(path)) return "client";
  return path.split("/", 1)[0] || "root";
}

function selectLayerDiversePaths(paths: string[], limit: number, reviewedPaths: string[] = [], chunkPaths: string[] = []): string[] {
  const selected = paths.length > 0 ? [paths[0]] : [];
  const reviewed = paths.find((path) => path !== paths[0] && reviewedPaths.includes(path) && !chunkPaths.includes(path)
    && !/(?:^|[/_.-])(?:test|tests|spec|specs|fixture|fixtures|schema|types?)(?:[/_.-]|$)/i.test(path));
  if (reviewed && selected.length < limit) selected.push(reviewed);
  const layers = new Set<string>();
  selected.forEach((path) => layers.add(contractLayer(path)));
  for (const path of paths) {
    if (selected.includes(path)) continue;
    const layer = contractLayer(path);
    if (layers.has(layer)) continue;
    selected.push(path);
    layers.add(layer);
    if (selected.length === limit) return selected;
  }
  for (const path of paths) {
    if (!reviewedPaths.includes(path) || chunkPaths.includes(path) || selected.includes(path)
        || /(?:^|[/_.-])(?:test|tests|spec|specs|fixture|fixtures|schema|types?)(?:[/_.-]|$)/i.test(path)) continue;
    selected.push(path);
    if (selected.length === limit) return selected;
  }
  for (const path of paths) {
    if (!selected.includes(path)) selected.push(path);
    if (selected.length === limit) break;
  }
  return selected;
}

function contractPathScore(path: string, changedPaths: string[], counterevidence = false): number {
  const authority = counterevidence && /(?:^|[/_.-])(?:schema|types?|validator|validation|generator|generate|serializer|writer)(?:[/_.-]|$)/i.test(path)
    ? 1000
    : counterevidence && /(?:^|\/)(?:backend|server|api)(?:\/|$)/i.test(path) ? 300 : 0;
  return authority + contractPathAffinity(path, changedPaths);
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
