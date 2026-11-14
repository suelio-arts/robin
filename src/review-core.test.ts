import { mapPool } from "./review-core";

describe("mapPool", () => {
  it("keeps at most the limit in flight, starts the next as one finishes, and keeps order", async () => {
    let inFlight = 0;
    let peak = 0;
    const finished: number[] = [];
    const delays = [30, 5, 5, 5, 5];
    const results = await mapPool(delays, 2, async (delay, index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delay));
      inFlight -= 1;
      finished.push(index);
      return index * 10;
    });
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
