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
});
