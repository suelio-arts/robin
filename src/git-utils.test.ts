import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitUtils } from "./git-utils";
import { buildFileContext } from "./review-context";

describe("GitUtils immutable local context", () => {
  let fixture: string;
  let base: string;
  let head: string;
  const run = (...args: string[]) => execFileSync("git", ["-C", fixture, ...args], {encoding: "utf8"});
  const commit = () => {
    run("add", "--all");
    run("-c", "user.name=Robin Test", "-c", "user.email=robin@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    return run("rev-parse", "HEAD").trim();
  };
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "robin-local-context-"));
    run("init", "-q", "-b", "main");
    writeFileSync(join(fixture, "file.txt"), "base café\r\n");
    base = commit();
    writeFileSync(join(fixture, "file.txt"), "head café\n");
    writeFileSync(join(fixture, "space ' [$HOME]\n.txt"), "literal bytes\n");
    mkdirSync(join(fixture, "dir"));
    writeFileSync(join(fixture, "dir/only.txt"), "nested bytes\n");
    symlinkSync("file.txt", join(fixture, "link.txt"));
    head = commit();
    run("update-index", "--add", "--cacheinfo", `160000,${base},submodule`);
    run("-c", "user.name=Robin Test", "-c", "user.email=robin@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "gitlink");
    head = run("rev-parse", "HEAD").trim();
    // The checkout is deliberately neither requested object.
    writeFileSync(join(fixture, "file.txt"), "untrusted working copy\n");
  });
  afterEach(() => rmSync(fixture, {recursive: true, force: true}));

  it("reads exact base/head bytes and literal unusual paths without any API request", async () => {
    const git = new GitUtils({} as never, fixture);
    await expect(git.getFileContent("o", "r", "file.txt", base)).resolves.toBe("base café\r\n");
    await expect(git.getFileContent("o", "r", "file.txt", head)).resolves.toBe("head café\n");
    await expect(git.getFileContent("o", "r", "space ' [$HOME]\n.txt", head)).resolves.toBe("literal bytes\n");
    await expect(git.getFileContent("o", "r", "dir/only.txt", head)).resolves.toBe("nested bytes\n");
    await expect(git.getTreePaths("o", "r", head)).resolves.toEqual(["dir/only.txt", "file.txt", "link.txt", "space ' [$HOME]\n.txt"]);
    await expect(git.getTreePaths("o", "r", base)).resolves.toEqual(["file.txt"]);
  });

  it("preserves API behavior for symlinks, missing paths and unavailable objects", async () => {
    const getContent = jest.fn().mockResolvedValue({data: {content: Buffer.from("API content").toString("base64")}});
    const getTree = jest.fn().mockResolvedValue({data: {tree: [{type: "blob", path: "remote.txt"}]}});
    const git = new GitUtils({rest: {repos: {getContent}, git: {getTree}}} as never, fixture);
    for (const [path, ref] of [["link.txt", head], ["missing.txt", head], ["file.txt", "a".repeat(40)]]) {
      await expect(git.getFileContent("o", "r", path, ref)).resolves.toBe("API content");
      expect(getContent).toHaveBeenLastCalledWith({owner: "o", repo: "r", path, ref});
    }
    await expect(git.getTreePaths("o", "r", "a".repeat(40))).resolves.toEqual(["remote.txt"]);
    expect(getTree).toHaveBeenCalledTimes(1);
  });

  it("does not substitute a mutable same-named local ref for the API ref", async () => {
    const getContent = jest.fn().mockResolvedValue({data: {content: Buffer.from("remote main").toString("base64")}});
    const git = new GitUtils({rest: {repos: {getContent}}} as never, fixture);
    await expect(git.getFileContent("o", "r", "file.txt", "main")).resolves.toBe("remote main");
    expect(getContent).toHaveBeenCalledTimes(1);
  });

  it("does not turn directory or normalized paths into file reads", async () => {
    const getContent = jest.fn().mockResolvedValue({data: []});
    const git = new GitUtils({rest: {repos: {getContent}}} as never, fixture);
    for (const path of ["dir/", "./file.txt"]) {
      await expect(git.getFileContent("o", "r", path, head)).resolves.toBe("");
      expect(getContent).toHaveBeenLastCalledWith({owner: "o", repo: "r", path, ref: head});
    }
  });

  it("retains complete context bytes compared with the previous API reader", async () => {
    const getContent = jest.fn(async ({path, ref}: {path: string; ref: string}) => {
      try { return {data: {content: Buffer.from(run("show", `${ref}:${path}`)).toString("base64")}}; }
      catch { throw new Error("not found"); }
    });
    const api = {getFileContent: async (owner: string, repo: string, path: string, ref: string) => {
      try { return Buffer.from((await getContent({path, ref})).data.content, "base64").toString("utf8"); }
      catch { return ""; }
    }, getTreePaths: async () => ["dir/only.txt", "file.txt", "link.txt", "space ' [$HOME]\n.txt"], searchPaths: async () => []};
    const local = new GitUtils({rest: {repos: {getContent}}} as never, fixture);
    const diff = run("diff", "--no-ext-diff", "--no-textconv", base, head, "--", "file.txt");
    const before = await buildFileContext(api, "o", "r", diff, base, head);
    const after = await buildFileContext({...api, getFileContent: local.getFileContent.bind(local), getTreePaths: local.getTreePaths.bind(local)}, "o", "r", diff, base, head);
    expect(after).toBe(before);
    expect(after).toContain("head café");
    expect(after).toContain("base café");
  });
});

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
