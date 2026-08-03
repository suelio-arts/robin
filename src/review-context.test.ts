import { focusedContext } from "./review-context";

describe("focusedContext", () => {
  it("keeps nearby contract evidence and drops unrelated bulk", () => {
    const context = ["a", "b", "c", "d", "setRuntime(failed, message)", "e", "f", "g", "h", "unrelated"].join("\n");
    const focused = focusedContext(context);

    expect(focused).toContain("setRuntime");
    expect(focused).not.toContain("unrelated");
  });
});
