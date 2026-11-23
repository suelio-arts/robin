import { MAX_REVIEW_PIECES, mapPool, reviewPieces, runReviewCore } from "./review-core";
import { LLMClient } from "./llm-client";
import { createCouncilSeat } from "./council";
import { createPrimarySeat } from "./primary-seat";
import { SubscriptionLimitError } from "./subscription-limit";
import { currentStage, ReviewTimings } from "./review-timing";

describe("mapPool", () => {
  it("keeps at most the limit in flight, starts the next as one finishes, and keeps order", async () => {
    let inFlight = 0;
    let peak = 0;
    const finished: number[] = [];
    const signal = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return {promise, resolve};
    };
    const items = Array.from({length: 5}, () => ({start: signal(), release: signal(), done: signal()}));
    const pending = mapPool(items, 2, async (item, index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      item.start.resolve();
      await item.release.promise;
      inFlight -= 1;
      finished.push(index);
      item.done.resolve();
      return index * 10;
    });
    // Hold item 0 while the other slot drains; no wall-clock assumptions under host load.
    for (let index = 1; index < items.length; index++) {
      await items[index].start.promise;
      items[index].release.resolve();
      await items[index].done.promise;
    }
    items[0].release.resolve();
    const results = await pending;
    expect(results).toEqual([0, 10, 20, 30, 40]);
    expect(peak).toBe(2);
    // Item 0 is slow; items 2-4 run through the second slot without waiting for it.
    expect(finished).toEqual([1, 2, 3, 4, 0]);
  });

  it("rejects with the first failure", async () => {
    await expect(mapPool([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error("piece 2 failed");
      return item;
    })).rejects.toThrow("piece 2 failed");
  });

  it("does not dispatch more pieces after a failure", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started: number[] = [];
    const result = mapPool([0, 1, 2, 3], 2, async (item) => {
      started.push(item);
      if (item === 0) throw new Error("quota");
      await waiting;
      return item;
    });
    await expect(result).rejects.toThrow("quota");
    release();
    await waiting;
    expect(started).toEqual([0, 1]);
  });

  it.each([0, -1, 1.5, NaN])("rejects invalid concurrency %s", async (limit) => {
    await expect(mapPool([1], limit, async (item) => item)).rejects.toThrow("positive integer");
  });

  it("handles no items", async () => {
    await expect(mapPool([], 4, async () => 1)).resolves.toEqual([]);
  });
});


it("keeps both discovery passes and gates every piece together after parallel prior loading", async () => {
  const passes: string[] = [];
  let priorStarted = false;
  let release!: () => void;
  const firstPiece = new Promise<void>((resolve) => { release = resolve; });
  const seat = (model: string): LLMClient => ({
    chatCompletion: async (_system: string, input: string) => {
      const stage = currentStage();
      expect(priorStarted).toBe(true);
      if (stage?.stage === "final-gate") {
        expect(passes).toHaveLength(4);
        expect(input).toContain("earlier finding");
        expect(input).toContain('"file":"a.ts"');
        expect(input).toContain('"file":"b.ts"');
        const proof = {trigger: "call", path: "changed line", impact: "failure", evidence: "exact diff"};
        return {content: JSON.stringify({approved: {c1: proof, c2: proof}, rejected: {}, already_reported: {}})};
      }
      passes.push(`${model}:${stage?.piece}`);
      if (stage?.piece === 1) await firstPiece;
      else release();
      return {content: JSON.stringify({summary: "", high: [], medium: [{
        file: stage?.piece === 1 ? "a.ts" : "b.ts", line: 1, description: "A concrete failure",
      }], low: [], suggestions: []})};
    },
  } as unknown as LLMClient);
  const llm = seat("primary");
  const council = createCouncilSeat({llm: seat("council"), model: "council"});
  const result = await runReviewCore({
    git: {getFileContent: async () => "", getTreePaths: async () => [], searchPaths: async () => []},
    owner: "o", repo: "r", baseRef: "base", headRef: "head",
    reviewDiff: ["a.ts", "b.ts"].map((file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`).join(""),
    maxDiffSize: 50000, pieceConcurrency: 2, reviewInstructions: "", jsonResponseMode: true,
    llm, council, timings: new ReviewTimings(),
    loadPriorFindings: async () => { priorStarted = true; return "earlier finding"; },
  });
  expect(result.pieces).toBe(2);
  expect(result.findings.medium.map(({file}) => file)).toEqual(["a.ts", "b.ts"]);
  expect(passes.sort()).toEqual(["council:1", "council:2", "primary:1", "primary:2"]);
  expect(council.gateVoted).toBe(true);
});

it("falls through a two-step primary fallback chain when subscription seats hit limits", async () => {
  const calls: string[] = [];
  const luna = {
    calls: [],
    chatCompletion: async () => {
      calls.push("luna");
      throw new SubscriptionLimitError("codex", "quota");
    },
    getMetrics: () => ({calls: 0, durationMs: 100, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0}),
  } as unknown as LLMClient;
  const personal = {
    calls: [],
    chatCompletion: async () => {
      calls.push("personal");
      throw new SubscriptionLimitError("codex", "quota");
    },
    getMetrics: () => ({calls: 0, durationMs: 200, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0}),
  } as unknown as LLMClient;
  const deepseek = {
    calls: [],
    chatCompletion: async () => {
      const stage = currentStage()?.stage ?? "unknown";
      calls.push(`deepseek:${stage}`);
      if (stage === "final-gate") {
        const proof = {trigger: "call", path: "changed line", impact: "failure", evidence: "exact diff"};
        return {content: JSON.stringify({approved: {c1: proof}, rejected: {}, already_reported: {}})};
      }
      return {content: JSON.stringify({summary: "", high: [{file: "a.ts", line: 1, description: "Real bug"}], medium: [], low: [], suggestions: []})};
    },
    getMetrics: () => ({calls: 3, durationMs: 500, inputTokens: 200, cachedInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 0}),
  } as unknown as LLMClient;
  const primary = createPrimarySeat(
    {llm: luna, model: "luna-6-high-subscription"},
    [
      {llm: personal, model: "luna-6-personal-high-subscription"},
      {llm: deepseek, model: "deepseek-v4.1-flash-deploy"},
    ]
  );
  const result = await runReviewCore({
    git: {getFileContent: async () => "", getTreePaths: async () => [], searchPaths: async () => []},
    owner: "o", repo: "r", baseRef: "base", headRef: "head",
    reviewDiff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    maxDiffSize: 50000, pieceConcurrency: 2, reviewInstructions: "", jsonResponseMode: true,
    llm: primary, timings: new ReviewTimings(),
    loadPriorFindings: async () => "",
  });
  expect(primary.model).toBe("deepseek-v4.1-flash-deploy");
  expect(primary.replaced.map(({model}) => model)).toEqual([
    "luna-6-high-subscription",
    "luna-6-personal-high-subscription",
  ]);
  expect(calls).toContain("luna");
  expect(calls).toContain("personal");
  expect(calls).toContain("deepseek:discovery");
  expect(calls).toContain("deepseek:final-gate");
  expect(result.findings.high).toHaveLength(1);
});

describe("reviewPieces", () => {
  const fileDiff = (file: string, lines: number) =>
    `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${lines} +0,0 @@\n${"-// gone\n".repeat(lines)}`;
  const diffOf = (files: number, lines = 1) =>
    Array.from({length: files}, (_, index) => fileDiff(`src/f${String(index).padStart(4, "0")}.ts`, lines)).join("");

  it("keeps one piece per file while the pull request fits the piece limit", () => {
    const diff = diffOf(MAX_REVIEW_PIECES);
    expect(reviewPieces(diff, 50000)).toEqual(Array.from({length: MAX_REVIEW_PIECES}, (_, index) =>
      fileDiff(`src/f${String(index).padStart(4, "0")}.ts`, 1)));
  });

  it.each([[MAX_REVIEW_PIECES + 1, 1], [503, 54], [5000, 40]])("packs %i files into at most the piece limit, every file in path order", (files, lines) => {
    const diff = diffOf(files, lines);
    const pieces = reviewPieces(diff, 50000);
    expect(pieces.length).toBeLessThanOrEqual(MAX_REVIEW_PIECES);
    expect(pieces.join("")).toBe(diff);
  });
});
