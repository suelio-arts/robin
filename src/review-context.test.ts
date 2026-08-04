import { buildFileContext, publicContractSubjects } from "./review-context";

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
    };
    const context = await buildFileContext(git, "o", "r", [
      "diff --git a/backend/endpoints/new.ts b/backend/endpoints/new.ts",
      "+++ b/backend/endpoints/new.ts",
      "+export const createThing = callable(() => true);",
    ].join("\n"), "base", "head");
    expect(context).toContain("HEAD CONVENTION FILE: backend/function-registry.ts");
  });

  it("extracts only literal public hosts and system commands for web lookup", () => {
    expect(publicContractSubjects('+API_BASE = "https://ads-api.x.com/12"\n+/usr/bin/lockf -s 9\n+privateThing()'))
      .toEqual(["ads-api.x.com", "system command lockf"]);
    expect(publicContractSubjects('+url = "https://user:token@internal.example/path"')).toEqual([]);
    expect(publicContractSubjects('+url = "https://jenkins.corp.internal/job/x"')).toEqual([]);
    expect(publicContractSubjects('+url = "https://127.0.0.1/private"')).toEqual([]);
  });
});
