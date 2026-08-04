import { GitUtils } from "./git-utils";

describe("GitUtils tree paths", () => {
  it("retries a failed tree fetch instead of caching the failure", async () => {
    const getTree = jest.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({data: {truncated: false, tree: [{type: "blob", path: "src/a.ts"}]}});
    const git = new GitUtils({rest: {git: {getTree}}} as never);

    await expect(git.getTreePaths("o", "r", "head")).resolves.toEqual([]);
    await expect(git.getTreePaths("o", "r", "head")).resolves.toEqual(["src/a.ts"]);
    expect(getTree).toHaveBeenCalledTimes(2);
  });

  it("coalesces repository code searches", async () => {
    const code = jest.fn().mockResolvedValue({data: {items: [{path: "src/a.ts"}]}});
    const git = new GitUtils({rest: {search: {code}}} as never);

    await expect(Promise.all([
      git.searchPaths("o", "r", "thing"),
      git.searchPaths("o", "r", "thing"),
    ])).resolves.toEqual([["src/a.ts"], ["src/a.ts"]]);
    expect(code).toHaveBeenCalledTimes(1);
  });
});
