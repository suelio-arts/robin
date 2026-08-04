import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";

export class GitUtils {
  private octokit: Octokit;
  private treePaths = new Map<string, Promise<string[]>>();

  constructor(octokit: Octokit) {
    this.octokit = octokit;
  }

  async getPullRequestDiff(owner: string, repo: string, pullNumber: number): Promise<string> {
    const response = await this.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: pullNumber,
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
    });

    return String(response.data);
  }

  async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });

      if ("content" in data) {
        return Buffer.from(data.content, "base64").toString("utf-8");
      }
      
      return "";
    } catch {
      return "";
    }
  }

  async getTreePaths(owner: string, repo: string, ref: string): Promise<string[]> {
    const key = `${owner}/${repo}@${ref}`;
    if (!this.treePaths.has(key)) {
      const pending = this.fetchTreePaths(owner, repo, ref).catch((error) => {
        this.treePaths.delete(key);
        core.warning(`Tree listing failed for ${owner}/${repo}@${ref}; later chunks will retry: ${error}`);
        return [];
      });
      this.treePaths.set(key, pending);
    }
    return this.treePaths.get(key) as Promise<string[]>;
  }

  private async fetchTreePaths(owner: string, repo: string, ref: string): Promise<string[]> {
    const { data } = await this.octokit.rest.git.getTree({owner, repo, tree_sha: ref, recursive: "true"});
    if (data.truncated) core.warning(`Tree listing for ${owner}/${repo}@${ref} was truncated`);
    return data.tree.filter((item) => item.type === "blob" && item.path).map((item) => item.path as string);
  }
}
