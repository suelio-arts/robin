import { buildFileContext } from "./review-context";

describe("buildFileContext", () => {
  it("adds identifier neighborhoods from direct relative imports at the PR head", async () => {
    const files: Record<string, string> = {
      "head:src/route.ts": 'import { Walk } from "./types";\nconst first = walk.orderedElementIds?.[0] ?? walk.nodes[0].elementId;',
      "base:src/route.ts": "",
      "head:src/types.ts": ["unrelated", "elementId?: string; // semantic linkage, NOT display order", "orderedElementIds?: string[]"].join("\n"),
    };
    const git = {
      getFileContent: async (_owner: string, _repo: string, path: string, ref: string) => files[`${ref}:${path}`] || "",
      getTreePaths: async () => [],
      searchPaths: async () => [],
    };
    const context = await buildFileContext(git, "o", "r", [
      "diff --git a/src/route.ts b/src/route.ts",
      "+++ b/src/route.ts",
      "+const first = walk.orderedElementIds?.[0] ?? walk.nodes[0].elementId;",
    ].join("\n"), "base", "head");
    expect(context).toContain("HEAD RELATED FILE: src/types.ts");
    expect(context).toContain("NOT display order");
  });

  it("adds exact-head convention files without relying on default-branch search", async () => {
    const files: Record<string, string> = {
      "head:backend/endpoints/new.ts": "export const createThing = callable(() => true);",
      "head:backend/function-registry.ts": 'register({ name: "createThing", requestSchema: "CreateThingRequestSchema" });',
    };
    const git = {
      getFileContent: async (_owner: string, _repo: string, path: string, ref: string) => files[`${ref}:${path}`] || "",
      getTreePaths: async () => ["backend/function-registry.ts"],
      searchPaths: async () => [],
    };
    const context = await buildFileContext(git, "o", "r", [
      "diff --git a/backend/endpoints/new.ts b/backend/endpoints/new.ts",
      "+++ b/backend/endpoints/new.ts",
      "+export const createThing = callable(() => true);",
    ].join("\n"), "base", "head");
    expect(context).toContain("HEAD CONVENTION FILE: backend/function-registry.ts");
  });

  it("adds repository lint configuration even without matching identifiers", async () => {
    const files: Record<string, string> = {
      "head:studio/task.py": "raise RuntimeError('long inline message')",
      "head:pyproject.toml": "[tool.ruff.lint]\nselect = [\"ALL\"]",
    };
    const git = {
      getFileContent: async (_owner: string, _repo: string, path: string, ref: string) => files[`${ref}:${path}`] || "",
      getTreePaths: async () => ["pyproject.toml"],
      searchPaths: async () => [],
    };
    const context = await buildFileContext(git, "o", "r", [
      "diff --git a/studio/task.py b/studio/task.py",
      "+++ b/studio/task.py",
      "+raise RuntimeError('long inline message')",
    ].join("\n"), "base", "head");
    expect(context).toContain("HEAD REPOSITORY CONFIG: pyproject.toml");
    expect(context).toContain('select = ["ALL"]');
  });

  it("keeps matching neighborhoods in source order", async () => {
    const related = Array.from({length: 20}, (_, index) => index === 1
      ? "secondaryIdentifier"
      : index === 15 ? "primaryIdentifier" : `line ${index + 1}`).join("\n");
    const files: Record<string, string> = {
      "head:src/route.ts": 'import { value } from "./related";\nprimaryIdentifier primaryIdentifier secondaryIdentifier',
      "head:src/related.ts": related,
    };
    const git = {
      getFileContent: async (_owner: string, _repo: string, path: string, ref: string) => files[`${ref}:${path}`] || "",
      getTreePaths: async () => [],
      searchPaths: async () => [],
    };
    const context = await buildFileContext(git, "o", "r", [
      "diff --git a/src/route.ts b/src/route.ts",
      "+++ b/src/route.ts",
      "+primaryIdentifier primaryIdentifier secondaryIdentifier",
    ].join("\n"), "base", "head");
    const lineNumbers = context.split("\n")
      .filter((line) => /^\d+: /.test(line))
      .map((line) => Number(line.split(":", 1)[0]));
    expect(lineNumbers).toEqual([...lineNumbers].sort((left, right) => left - right));
  });

  it("adds exact-head repository search matches", async () => {
    const files: Record<string, string> = {
      "head:src/route.ts": "const result = canonicalOperation(value);",
      "head:src/contract.ts": "export function canonicalOperation(value: string) { return value.trim(); }",
    };
    const git = {
      getFileContent: async (_owner: string, _repo: string, path: string, ref: string) => files[`${ref}:${path}`] || "",
      getTreePaths: async () => [],
      searchPaths: async (_owner: string, _repo: string, query: string) => query === "canonicalOperation" ? ["src/contract.ts"] : [],
    };
    const context = await buildFileContext(git, "o", "r", [
      "diff --git a/src/route.ts b/src/route.ts",
      "+++ b/src/route.ts",
      "+const result = canonicalOperation(value);",
    ].join("\n"), "base", "head");
    expect(context).toContain("HEAD REPOSITORY SEARCH MATCH: src/contract.ts");
    expect(context).toContain("value.trim()");
  });

  it("searches removed hashes and includes nearby Firebase configuration", async () => {
    const oldHash = "304b4dc52a563af576f1a6977958471f922701a62391487204dff976096c909a";
    const files: Record<string, string> = {
      "head:web/qr/page.ts": "const hash = \"new-hash\";",
      "base:web/qr/page.ts": `const hash = "${oldHash}";`,
      "head:docs/release.md": `Expected hash: ${oldHash}`,
      "head:web/CLAUDE.md": "Studio saves rebuild complete projected state.",
      "head:web/firebase.json": '{"headers":[{"source":"*-v@(1|2|3|4|5|6|7).mjs"}]}',
    };
    const git = {
      getFileContent: async (_owner: string, _repo: string, path: string, ref: string) => files[`${ref}:${path}`] || "",
      getTreePaths: async () => ["docs/release.md", "web/CLAUDE.md", "web/firebase.json"],
      searchPaths: async (_owner: string, _repo: string, query: string) => query === oldHash ? ["web/firebase.json", "docs/release.md"] : [],
    };
    const context = await buildFileContext(git, "o", "r", [
      "diff --git a/web/qr/page.ts b/web/qr/page.ts",
      "--- a/web/qr/page.ts",
      "+++ b/web/qr/page.ts",
      `-const hash = "${oldHash}";`,
      '+const hash = "new-hash";',
    ].join("\n"), "base", "head");
    expect(context).toContain("HEAD REPOSITORY CONFIG: web/firebase.json");
    expect(context).toContain("HEAD REPOSITORY CONFIG: web/CLAUDE.md");
    expect(context).toContain("HEAD REPOSITORY SEARCH MATCH: docs/release.md");
    expect(context).toContain(oldHash);
    expect(context).toContain('"source":"*-v@(1|2|3|4|5|6|7).mjs"');
    expect(context.indexOf("HEAD REPOSITORY CONFIG")).toBeLessThan(context.indexOf("HEAD REPOSITORY SEARCH MATCH"));
  });

  it("reserves context for configuration before repository search matches", async () => {
    const files: Record<string, string> = {
      "head:src/change.ts": "canonicalOperation();",
      "head:firebase.json": '{"hosting":{"headers":[]}}',
      ...Object.fromEntries(Array.from({length: 12}, (_, index) => [
        `head:src/match-${index}.ts`,
        `canonicalOperation\n${"x".repeat(20000)}`,
      ])),
    };
    const git = {
      getFileContent: async (_owner: string, _repo: string, path: string, ref: string) => files[`${ref}:${path}`] || "",
      getTreePaths: async () => ["firebase.json"],
      searchPaths: async () => Array.from({length: 12}, (_, index) => `src/match-${index}.ts`),
    };
    const context = await buildFileContext(git, "o", "r", [
      "diff --git a/src/change.ts b/src/change.ts",
      "+++ b/src/change.ts",
      "+canonicalOperation();",
    ].join("\n"), "base", "head");

    expect(context).toContain("HEAD REPOSITORY CONFIG: firebase.json");
  });

  it("searches identifiers from source lines beginning with increment operators", async () => {
    const queries: string[] = [];
    await buildFileContext({
      getFileContent: async () => "",
      getTreePaths: async () => [],
      searchPaths: async (_owner: string, _repo: string, query: string) => { queries.push(query); return []; },
    }, "o", "r", [
      "diff --git a/src/counter.ts b/src/counter.ts",
      "+++ b/src/counter.ts",
      "+++counterValue;",
    ].join("\n"), "base", "head");

    expect(queries).toContain("counterValue");
  });

  it("focuses oversized changed files on matching code beyond the head and tail", async () => {
    const lines = Array.from({length: 4000}, (_, index) => `const filler${index} = ${index};`);
    lines[2000] = "function canonicalOperation() { return persistedValue.trim(); }";
    const files: Record<string, string> = {
      "head:src/large.ts": lines.join("\n"),
    };
    const git = {
      getFileContent: async (_owner: string, _repo: string, path: string, ref: string) => files[`${ref}:${path}`] || "",
      getTreePaths: async () => [],
      searchPaths: async () => [],
    };
    const context = await buildFileContext(git, "o", "r", [
      "diff --git a/src/large.ts b/src/large.ts",
      "+++ b/src/large.ts",
      "+canonicalOperation();",
    ].join("\n"), "base", "head");
    expect(context).toContain("persistedValue.trim()");
  });

  it("includes complete small imported predicates so rejection guards remain visible", async () => {
    const files: Record<string, string> = {
      "head:src/check.ts": 'import { accepts } from "./predicate";\naccepts(value);',
      "base:src/check.ts": "",
      "head:src/predicate.ts": "export function accepts(value: {generating?: boolean}) {\n  return value.generating !== true;\n}",
    };
    const git = {
      getFileContent: async (_owner: string, _repo: string, path: string, ref: string) => files[`${ref}:${path}`] || "",
      getTreePaths: async () => [],
      searchPaths: async () => [],
    };
    const context = await buildFileContext(git, "o", "r", [
      "diff --git a/src/check.ts b/src/check.ts",
      "+++ b/src/check.ts",
      "+accepts(value);",
    ].join("\n"), "base", "head");
    expect(context).toContain("value.generating !== true");
  });

});
