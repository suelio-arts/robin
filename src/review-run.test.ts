import * as core from "@actions/core";
import { parseOutcomeMarker } from "./outcome";
import {
  ReviewTarget,
  handleReviewFailure,
  postSkippedReceipt,
  resolveAgentCaller,
  resolveReviewTarget,
} from "./review-run";

const HEAD = "a".repeat(40);
const STALE = "b".repeat(40);

function mockOctokit(createReviewResult: unknown = {data: {id: 99, html_url: "https://gh/r/1#pullrequestreview-99"}}) {
  const createReview = jest.fn().mockResolvedValue(createReviewResult);
  const get = jest.fn();
  return {
    createReview,
    get,
    octokit: {
      paginate: jest.fn().mockResolvedValue([]),
      rest: {
        pulls: {get, createReview, listReviews: {}, dismissReview: jest.fn().mockResolvedValue({})},
      },
    },
  };
}

function outputs(setOutput: jest.SpyInstance): Record<string, string> {
  return Object.fromEntries(setOutput.mock.calls.map(([name, value]) => [name, value]));
}

const target: ReviewTarget = {owner: "o", repo: "r", pullNumber: 7, headSha: HEAD, baseSha: "c".repeat(40)};

describe("terminal review outcomes", () => {
  let setOutput: jest.SpyInstance;
  let setFailed: jest.SpyInstance;
  let warning: jest.SpyInstance;

  beforeEach(() => {
    setOutput = jest.spyOn(core, "setOutput").mockImplementation(() => undefined);
    setFailed = jest.spyOn(core, "setFailed").mockImplementation(() => undefined);
    warning = jest.spyOn(core, "warning").mockImplementation(() => undefined);
    jest.spyOn(core, "info").mockImplementation(() => undefined);
    jest.spyOn(core, "error").mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it("resolves a target only when the head still matches", async () => {
    const {octokit, get} = mockOctokit();
    get.mockResolvedValue({data: {head: {sha: HEAD}, base: {sha: "c".repeat(40)}}});

    await expect(resolveReviewTarget(octokit, "o", "r", 7, HEAD)).resolves.toEqual(target);
    expect(outputs(setOutput)).toEqual({});
  });

  it("posts nothing and reports stale-head at the current head when the PR advanced", async () => {
    const {octokit, get, createReview} = mockOctokit();
    get.mockResolvedValue({data: {head: {sha: HEAD}, base: {sha: "c".repeat(40)}}});

    await expect(resolveReviewTarget(octokit, "o", "r", 7, STALE)).rejects.toThrow("head advanced");

    expect(createReview).not.toHaveBeenCalled();
    expect(outputs(setOutput)).toEqual({
      outcome: "stale-head",
      head: HEAD,
      "review-id": "",
      "review-url": "",
      verdict: "",
      high: "",
      medium: "",
      low: "",
      suggestions: "",
    });
  });

  it("posts an incomplete receipt at the head in advisory mode without failing the job", async () => {
    const {octokit, createReview} = mockOctokit();

    await handleReviewFailure({
      gatekeeper: false,
      octokit,
      target,
      message: "provider timeout",
      command: "review",
    });

    expect(createReview).toHaveBeenCalledTimes(1);
    const body = createReview.mock.calls[0][0].body;
    expect(createReview.mock.calls[0][0].event).toBe("COMMENT");
    expect(parseOutcomeMarker(body)).toEqual({
      outcome: "incomplete",
      head: HEAD,
      counts: {high: 0, medium: 0, low: 0, suggestions: 0},
    });
    expect(setFailed).not.toHaveBeenCalled();
    expect(outputs(setOutput)).toMatchObject({outcome: "incomplete", head: HEAD, "review-id": "99", high: "0"});
  });

  it("posts the same incomplete receipt in gatekeeper mode and fails the job", async () => {
    const {octokit, createReview} = mockOctokit();

    await handleReviewFailure({
      gatekeeper: true,
      octokit,
      target,
      message: "provider timeout",
      command: "review",
    });

    expect(createReview).toHaveBeenCalledTimes(1);
    expect(parseOutcomeMarker(createReview.mock.calls[0][0].body)?.outcome).toBe("incomplete");
    expect(setFailed).toHaveBeenCalledWith("provider timeout");
  });

  it("posts nothing when no validated target exists", async () => {
    const {octokit, createReview} = mockOctokit();

    await handleReviewFailure({
      gatekeeper: true,
      octokit,
      target: undefined,
      message: "Pull request head advanced",
      command: "review",
    });

    expect(createReview).not.toHaveBeenCalled();
    expect(outputs(setOutput)).toEqual({});
    expect(setFailed).toHaveBeenCalled();
  });

  it("still applies the exit rule when the receipt itself cannot be posted", async () => {
    const {octokit, createReview} = mockOctokit();
    createReview.mockRejectedValue(new Error("403"));

    await handleReviewFailure({gatekeeper: false, octokit, target, message: "boom", command: "review"});

    expect(setFailed).not.toHaveBeenCalled();
    expect(outputs(setOutput)).toMatchObject({outcome: "incomplete", head: HEAD, "review-id": ""});
  });

  it("posts a head-bound skipped receipt for a head with nothing reviewable", async () => {
    const {octokit, createReview} = mockOctokit();

    await postSkippedReceipt(octokit, target, "only whitespace changed.");

    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({owner: "o", repo: "r", pull_number: 7, event: "COMMENT"})
    );
    expect(parseOutcomeMarker(createReview.mock.calls[0][0].body)).toEqual({
      outcome: "skipped",
      head: HEAD,
      counts: {high: 0, medium: 0, low: 0, suggestions: 0},
    });
    expect(outputs(setOutput)).toMatchObject({outcome: "skipped", head: HEAD, verdict: "COMMENTED"});
    expect(warning).not.toHaveBeenCalled();
  });
});

describe("agent caller attribution", () => {
  it("accepts the three known callers and defaults everything else to github", () => {
    expect(resolveAgentCaller("codex")).toBe("codex");
    expect(resolveAgentCaller("claude")).toBe("claude");
    expect(resolveAgentCaller("github")).toBe("github");
    expect(resolveAgentCaller(" codex ")).toBe("codex");
    expect(resolveAgentCaller(undefined)).toBe("github");
    expect(resolveAgentCaller("")).toBe("github");
    expect(resolveAgentCaller("root")).toBe("github");
  });
});
