import { STATUS_END, STATUS_START, statusComment, statusLine, withStatus } from "./status";

const HEAD = "a".repeat(40);

describe("Robin status region", () => {
  it("starts a comment with only Robin's region", () => {
    expect(withStatus(undefined, "line")).toBe(`${STATUS_START}\nline\n${STATUS_END}`);
  });

  it("rewrites only Robin's region in a shared comment", () => {
    const shared = `<!-- ci -->\nCI rows\n${withStatus(undefined, "old")}\nmore CI`;
    expect(withStatus(shared, "new")).toBe(`<!-- ci -->\nCI rows\n${STATUS_START}\nnew\n${STATUS_END}\nmore CI`);
  });

  it("names the head, counts and review link, and always offers /robin", () => {
    expect(statusLine.reviewed(HEAD, {high: 1, medium: 2, low: 3, suggestions: 4}, "https://r")).toContain("`aaaaaaa`: 1 High, 2 Medium, 3 Low · [review](https://r)");
    expect(statusLine.failed(HEAD, "provider timeout.\nstack")).toBe("**:bow_and_arrow: Robin:** :warning: could not finish `aaaaaaa`: provider timeout. Comment `/robin` to retry.");
    expect(statusLine.interrupted(HEAD)).toContain("/robin");
  });

  it("updates the bot comment that holds the region and creates one otherwise", async () => {
    const updateComment = jest.fn();
    const createComment = jest.fn();
    const comments = [
      {id: 1, user: {type: "User"}, body: withStatus(undefined, "forged")},
      {id: 2, user: {type: "Bot"}, body: `ci\n${withStatus(undefined, "old")}`},
    ];
    const octokit = {paginate: jest.fn().mockResolvedValue(comments), rest: {issues: {listComments: {}, updateComment, createComment}}};
    await statusComment(octokit, "o", "r", 7)("new");
    expect(updateComment).toHaveBeenCalledWith({owner: "o", repo: "r", comment_id: 2, body: `ci\n${withStatus(undefined, "new")}`});
    expect(createComment).not.toHaveBeenCalled();

    octokit.paginate.mockResolvedValue([]);
    await statusComment(octokit, "o", "r", 7)("first");
    expect(createComment).toHaveBeenCalledWith({owner: "o", repo: "r", issue_number: 7, body: withStatus(undefined, "first")});
  });
});
