import { executeEvidenceRequests, parseEvidenceRequests } from "./evidence-loop";

describe("evidence loop", () => {
  it("validates bounded typed requests", () => {
    expect(parseEvidenceRequests([
      {kind: "callers", query: "parseAuth", reason: "prove reachability"},
      {kind: "file", path: "../secret", reason: "escape"},
      {kind: "shell", query: "rm", reason: "invalid"},
      {kind: "file", path: "src/auth.ts", startLine: 3, endLine: 5, reason: "inspect guard"},
    ])).toEqual([
      {kind: "callers", query: "parseAuth", path: undefined, startLine: undefined, endLine: undefined, reason: "prove reachability"},
      {kind: "file", query: undefined, path: "src/auth.ts", startLine: 3, endLine: 5, reason: "inspect guard"},
    ]);
  });

  it("returns only exact-head, bounded evidence and marks it untrusted", async () => {
    const files: Record<string, string> = {
      "head:src/auth.ts": "one\nparseAuth(input)\nthree\nfour\nfive",
      "head:tests/auth.test.ts": "test('auth', () => parseAuth('bad'))",
    };
    const evidence = await executeEvidenceRequests({
      getTreePaths: async () => ["src/auth.ts", "tests/auth.test.ts"],
      searchPaths: async () => ["src/auth.ts", "missing.ts"],
      getFileContent: async (_owner, _repo, path, ref) => files[`${ref}:${path}`] || "",
    }, "o", "r", "head", [
      {kind: "callers", query: "parseAuth", reason: "prove caller"},
      {kind: "file", path: "missing.ts", reason: "must not read missing head path"},
    ]);
    expect(evidence).toContain("untrusted exact-head repository evidence");
    expect(evidence).toContain("EXACT-HEAD FILE: src/auth.ts");
    expect(evidence).not.toContain("missing.ts");
  });
});
