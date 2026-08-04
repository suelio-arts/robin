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
});
