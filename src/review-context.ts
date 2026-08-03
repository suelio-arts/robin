import { splitDiffIntoFiles } from "./diff-filter";
import { GitUtils } from "./git-utils";

const CONTEXT_LIMIT = 50000;
const FILE_LIMIT = 20000;

function excerpt(content: string, limit: number): string {
  if (content.length <= limit) return content;
  return `${content.slice(0, Math.floor(limit * 0.75))}\n[... middle omitted ...]\n${content.slice(-Math.floor(limit * 0.25))}`;
}

export async function buildFileContext(
  git: GitUtils,
  owner: string,
  repo: string,
  chunk: string,
  base: string,
  head: string
): Promise<string> {
  let remaining = CONTEXT_LIMIT;
  const sections: string[] = [];

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
      const value = excerpt(content, Math.min(FILE_LIMIT, remaining));
      sections.push(`${label} FILE: ${path}\n${value}`);
      remaining -= value.length;
    }
  }

  return sections.join("\n\n");
}

export function focusedContext(context: string): string {
  const lines = context.split("\n");
  const selected = new Set<number>();
  const pattern = /setRuntime|errorLabel|split\(|parts\[0\]|UserDefaults|qualifiedAt|make_client|assert-autopilot|localization|create_version|pending|mirrored/i;

  lines.forEach((line, index) => {
    if (!pattern.test(line)) return;
    for (let nearby = Math.max(0, index - 4); nearby <= Math.min(lines.length - 1, index + 4); nearby += 1) {
      selected.add(nearby);
    }
  });

  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => lines[index])
    .join("\n")
    .slice(0, FILE_LIMIT);
}
