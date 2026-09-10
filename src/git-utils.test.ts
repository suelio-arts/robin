import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitUtils } from "./git-utils";

describe("GitUtils tree paths", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("retries a failed tree fetch instead of caching the failure", async () => {
    const getTree = jest.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({data: {truncated: false, tree: [{type: "blob", path: "src/a.ts"}]}});
    const git = new GitUtils({rest: {git: {getTree}}} as never, process.cwd());

    await expect(git.getTreePaths("o", "r", "head")).resolves.toEqual([]);
    await expect(git.getTreePaths("o", "r", "head")).resolves.toEqual(["src/a.ts"]);
    expect(getTree).toHaveBeenCalledTimes(2);
  });

  it("searches the checked-out exact head and coalesces identical queries", async () => {
    const git = new GitUtils({} as never, process.cwd());
    const query = ["coalesces repository", " file reads"].join("");

    await expect(Promise.all([
      git.searchPaths("o", "r", query),
      git.searchPaths("o", "r", query),
    ])).resolves.toEqual([["src/git-utils.test.ts"], ["src/git-utils.test.ts"]]);
  });

  it("coalesces repository file reads", async () => {
    const getContent = jest.fn().mockResolvedValue({data: {content: Buffer.from("value").toString("base64")}});
    const git = new GitUtils({rest: {repos: {getContent}}} as never, process.cwd());

    await expect(Promise.all([
      git.getFileContent("o", "r", "src/a.ts", "head"),
      git.getFileContent("o", "r", "src/a.ts", "head"),
    ])).resolves.toEqual(["value", "value"]);
    expect(getContent).toHaveBeenCalledTimes(1);
  });

  it("requires a checkout for repository search", async () => {
    expect(() => new GitUtils({} as never, "")).toThrow("requires actions/checkout");
  });

  it("reads the complete diff from the checkout instead of GitHub's aggregate diff endpoint", async () => {
    const request = jest.fn();
    const git = new GitUtils({request} as never, process.cwd());
    const diff = await git.getPullRequestDiff("HEAD", "HEAD");
    expect(diff).toBe("");
    expect(request).not.toHaveBeenCalled();
  });
});

/**
 * `--no-ext-diff` disables external diff drivers but NOT textconv filters, which
 * are a separate mechanism: a `diff=<driver>` line in the tree's `.gitattributes`
 * plus a `diff.<driver>.textconv` config entry makes `git diff` run that command
 * on the file's contents. Robin reads the diff from a checkout of PR code, and
 * `--local` promises the engine never executes anything the pull request brings
 * with it, so the diff read must not be a code-execution path.
 */
describe("GitUtils diff never runs a configured textconv filter", () => {
  let fixture: string;
  let marker: string;
  let baseSha: string;
  let headSha: string;
  const savedEnv: Record<string, string | undefined> = {};

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", fixture, ...args], {encoding: "utf8"}).trim();

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "robin-textconv-"));
    marker = join(fixture, "textconv-ran");

    // Isolate from the developer's real git configuration in both directions:
    // a global textconv driver must not create a false positive, and a global
    // setting must not mask the repo-local driver under test.
    for (const key of ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.HOME = fixture;
    process.env.GIT_CONFIG_GLOBAL = join(fixture, "gitconfig-global");
    process.env.GIT_CONFIG_SYSTEM = join(fixture, "gitconfig-system");
    process.env.GIT_CONFIG_NOSYSTEM = "1";

    const converter = join(fixture, "converter.sh");
    writeFileSync(converter, `#!/bin/sh\n: > '${marker}'\ncat "$1"\n`);
    chmodSync(converter, 0o755);

    git("init", "-q", "-b", "main");
    git("config", "user.email", "robin@example.invalid");
    git("config", "user.name", "Robin Test");
    git("config", "commit.gpgsign", "false");
    git("config", "diff.marker.textconv", converter);

    writeFileSync(join(fixture, "sample.txt"), "base line\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    baseSha = git("rev-parse", "HEAD");

    // Everything below this line is what a pull request controls.
    writeFileSync(join(fixture, ".gitattributes"), "*.txt diff=marker\n");
    writeFileSync(join(fixture, "sample.txt"), "changed line\n");
    git("add", "-A");
    git("commit", "-q", "-m", "head");
    headSha = git("rev-parse", "HEAD");
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(fixture, {recursive: true, force: true});
  });

  it("reads the diff without executing the filter the checked-out tree asks for", async () => {
    const diff = await new GitUtils({} as never, fixture).getPullRequestDiff(baseSha, headSha);

    expect(existsSync(marker)).toBe(false);
    expect(diff).toContain("changed line");
  });

  it("proves the fixture would trigger the filter without the guard", () => {
    // Guards the guard: if a future git release stopped honouring this driver,
    // the test above would pass for the wrong reason and silently stop
    // protecting anything.
    git("diff", "--no-ext-diff", "--no-color", `${baseSha}...${headSha}`, "--");
    expect(existsSync(marker)).toBe(true);
  });
});
