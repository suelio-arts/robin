import {
  OUTCOME_MARKER_PATTERN,
  appendOutcomeMarker,
  buildOutcomeMarker,
  parseOutcomeMarker,
} from "./outcome";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);

describe("outcome marker", () => {
  it("emits the exact v1 marker shape consumers parse", () => {
    expect(buildOutcomeMarker("reviewed", HEAD, {high: 1, medium: 2, low: 3, suggestions: 4})).toBe(
      `<!-- robin-outcome: v1 reviewed head=${HEAD} high=1 medium=2 low=3 suggestions=4 -->`
    );
    expect(buildOutcomeMarker("reused", HEAD)).toBe(`<!-- robin-outcome: v1 reused head=${HEAD} -->`);
  });

  it("round-trips every outcome through the shared regex", () => {
    for (const outcome of ["reviewed", "reused", "skipped", "incomplete"] as const) {
      const counts = {high: 0, medium: 1, low: 0, suggestions: 2};
      const body = appendOutcomeMarker("## :bow_and_arrow: Robin\n\nbody", outcome, HEAD, counts);
      expect(parseOutcomeMarker(body)).toEqual({outcome, head: HEAD, counts});
    }
  });

  it("lets the last marker win so a reused body names the head it was re-posted at", () => {
    const cached = appendOutcomeMarker("original review", "reviewed", OTHER_HEAD, {
      high: 1, medium: 0, low: 0, suggestions: 0,
    });
    const reused = appendOutcomeMarker(`> quoted\n\n${cached}`, "reused", HEAD, {
      high: 1, medium: 0, low: 0, suggestions: 0,
    });

    expect(parseOutcomeMarker(reused)).toEqual({
      outcome: "reused",
      head: HEAD,
      counts: {high: 1, medium: 0, low: 0, suggestions: 0},
    });
  });

  it("reports null counts when the marker carries none", () => {
    expect(parseOutcomeMarker(buildOutcomeMarker("reused", HEAD))).toEqual({
      outcome: "reused",
      head: HEAD,
      counts: null,
    });
  });

  it("ignores bodies with no marker and malformed markers", () => {
    expect(parseOutcomeMarker("## :bow_and_arrow: Robin\n\nno marker here")).toBeNull();
    expect(parseOutcomeMarker("")).toBeNull();
    // short head, unknown outcome, and a v2 marker are all rejected
    expect(parseOutcomeMarker("<!-- robin-outcome: v1 reviewed head=abc123 -->")).toBeNull();
    expect(parseOutcomeMarker(`<!-- robin-outcome: v1 approved head=${HEAD} -->`)).toBeNull();
    expect(parseOutcomeMarker(`<!-- robin-outcome: v2 reviewed head=${HEAD} -->`)).toBeNull();
  });

  it("keeps the shared pattern global and reusable across calls", () => {
    // A stateful global regex would make the second parse of the same body fail.
    const body = buildOutcomeMarker("skipped", HEAD, {high: 0, medium: 0, low: 0, suggestions: 0});
    expect(OUTCOME_MARKER_PATTERN.flags).toContain("g");
    expect(parseOutcomeMarker(body)).toEqual(parseOutcomeMarker(body));
  });
});
