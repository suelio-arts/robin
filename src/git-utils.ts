import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class GitUtils {
  private octokit: Octokit;
  private contents = new Map<string, Promise<string>>();
  private treePaths = new Map<string, Promise<string[]>>();
  private searches = new Map<string, Promise<string[]>>();
  private workspace: string;

  constructor(octokit: Octokit, workspace = process.env.GITHUB_WORKSPACE) {
    if (!workspace || !existsSync(join(workspace, ".git"))) {
      throw new Error("Robin repository search requires actions/checkout");
    }
    this.octokit = octokit;
    this.workspace = workspace;
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
    const key = `${owner}/${repo}@${ref}:${path}`;
    if (!this.contents.has(key)) this.contents.set(key, this.fetchFileContent(owner, repo, path, ref));
    return this.contents.get(key) as Promise<string>;
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

  async searchPaths(owner: string, repo: string, query: string): Promise<string[]> {
    const key = `${owner}/${repo}:${query}`;
    if (!this.searches.has(key)) this.searches.set(key, this.searchWorkspace(query));
    return this.searches.get(key) as Promise<string[]>;
  }

  private async fetchFileContent(owner: string, repo: string, path: string, ref: string): Promise<string> {
    try {
      const {data} = await this.octokit.rest.repos.getContent({owner, repo, path, ref});
      return "content" in data ? Buffer.from(data.content, "base64").toString("utf-8") : "";
    } catch {
      return "";
    }
  }

  private async searchWorkspace(query: string): Promise<string[]> {
    try {
      const {stdout} = await exec("git", ["-C", this.workspace, "grep", "-l", "-z", "-F", "-e", query, "HEAD", "--"], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout.split("\0").filter(Boolean).map((path) => path.replace(/^HEAD:/, ""));
    } catch (error) {
      if ((error as {code?: number}).code === 1) return [];
      throw new Error(`Local repository search failed: ${error}`);
    }
  }

  private async fetchTreePaths(owner: string, repo: string, ref: string): Promise<string[]> {
    const { data } = await this.octokit.rest.git.getTree({owner, repo, tree_sha: ref, recursive: "true"});
    if (data.truncated) core.warning(`Tree listing for ${owner}/${repo}@${ref} was truncated`);
    return data.tree.filter((item) => item.type === "blob" && item.path).map((item) => item.path as string);
  }
}
