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

  it("retries a failed repository code search", async () => {
    jest.useFakeTimers();
    const code = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error("temporary"), {status: 429}))
      .mockResolvedValueOnce({data: {items: [{path: "src/a.ts"}]}});
    const git = new GitUtils({rest: {search: {code}}} as never);

    const search = git.searchPaths("o", "r", "thing");
    await jest.advanceTimersByTimeAsync(1000);
    await expect(search).resolves.toEqual(["src/a.ts"]);
    expect(code).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it("fails closed and evicts a search after three failures", async () => {
    jest.useFakeTimers();
    const code = jest.fn().mockRejectedValue(Object.assign(new Error("unavailable"), {status: 503}));
    const git = new GitUtils({rest: {search: {code}}} as never);

    const first = git.searchPaths("o", "r", "thing");
    const firstFailure = expect(first).rejects.toThrow("unavailable");
    await jest.advanceTimersByTimeAsync(3000);
    await firstFailure;
    const second = git.searchPaths("o", "r", "thing");
    const secondFailure = expect(second).rejects.toThrow("unavailable");
    await jest.advanceTimersByTimeAsync(3000);
    await secondFailure;
    expect(code).toHaveBeenCalledTimes(6);
    jest.useRealTimers();
  });

  it("does not retry a non-transient repository search failure", async () => {
    const code = jest.fn().mockRejectedValue(Object.assign(new Error("invalid query"), {status: 422}));
    const git = new GitUtils({rest: {search: {code}}} as never);

    await expect(git.searchPaths("o", "r", "thing")).rejects.toThrow("invalid query");
    expect(code).toHaveBeenCalledTimes(1);
  });
});
