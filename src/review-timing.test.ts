import { ReviewTimings, currentStage, percentile, union } from "./review-timing";

describe("review timing", () => {
  it("counts overlapping spans once", () => {
    expect(union([{startMs: 0, endMs: 10}, {startMs: 5, endMs: 12}, {startMs: 20, endMs: 25}, {startMs: 21, endMs: 22}])).toBe(17);
  });

  it("takes the nearest-rank percentile", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([], 0.5)).toBe(0);
  });

  it("exposes the running stage to calls made inside it", async () => {
    const timings = new ReviewTimings(0);
    const seen = await timings.time("discovery", async () => currentStage(), 3);
    expect(seen).toEqual({stage: "discovery", piece: 3});
    expect(currentStage()).toBeUndefined();
    expect(timings.spans).toEqual([expect.objectContaining({stage: "discovery", piece: 3})]);
  });

  it("summarizes stages and seats", () => {
    const timings = new ReviewTimings(0);
    timings.spans.push(
      {stage: "context", piece: 1, startMs: 0, endMs: 2000},
      {stage: "discovery", piece: 1, startMs: 2000, endMs: 32000},
      {stage: "final-gate", startMs: 32000, endMs: 40000},
    );
    const receipt = timings.receipt([
      {model: "sol", calls: [{startMs: 2000, endMs: 30000, providerMs: 25000, inFlight: 1}, {startMs: 32000, endMs: 40000, inFlight: 2}]},
      {model: "unused", calls: []},
    ]);
    expect(receipt).toBe([
      "Robin timing: 40.0s · context 2.0s · discovery 30.0s · final-gate 8.0s",
      "Robin seat: sol 2 calls, p50 8.0s, max 28.0s, provider p50 25.0s, peak 2 in flight, 0 failed, client queue 0.0s",
    ].join("\n"));
    expect(timings.pieceLine(1, 4)).toBe("Piece 1/4 done in 32.0s (context 2.0s, discovery 30.0s), finished at +32.0s");
  });
});
