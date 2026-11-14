import * as core from "@actions/core";
import type { GitUtils } from "./git-utils";
import { RepoConfig, parseRepoConfigYaml } from "./repo-config";

type SettingsGit = Pick<GitUtils, "getFileContent">;

/** The repository's Robin config at the trusted base; absent or unreadable means defaults. */
export async function loadRepoConfig(git: SettingsGit, owner: string, repo: string, configFile: string, baseRef: string): Promise<RepoConfig> {
  const filePath = configFile.trim();
  if (!filePath) return {};
  try {
    const fileContent = await git.getFileContent(owner, repo, filePath, baseRef);
    if (!fileContent.trim()) return {};
    core.info(`Loaded repo config from ${filePath}`);
    return parseRepoConfigYaml(fileContent);
  } catch (error) {
    core.info(`No repo config at ${filePath} (${error})`);
    return {};
  }
}

/** Inline instructions plus the instructions file at the trusted base. */
export async function loadReviewInstructions(
  git: SettingsGit,
  owner: string,
  repo: string,
  inlineInstructions: string,
  instructionsFile: string,
  baseRef: string
): Promise<string> {
  const instructions = inlineInstructions.trim() ? [inlineInstructions.trim()] : [];
  const filePath = instructionsFile.trim();
  if (!filePath) return instructions.join("\n\n");
  try {
    const fileInstructions = await git.getFileContent(owner, repo, filePath, baseRef);
    if (fileInstructions.trim()) {
      core.info(`Loaded reviewer instructions from ${filePath}`);
      instructions.push(`Instructions from ${filePath}:\n${fileInstructions.trim()}`);
    }
  } catch (error) {
    core.warning(`Could not load review instructions from ${filePath}: ${error}`);
  }
  return instructions.join("\n\n");
}
