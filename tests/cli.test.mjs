import assert from "node:assert/strict";
import test from "node:test";
import { parseCli } from "../dist/cli.js";

test("CLI arguments are converted to a config override", () => {
  const result = parseCli([
    "start",
    "--branch=master",
    "--pr-master-branch=main",
    "--pr-staging-branch=staging",
    "--branch-prefix=fix",
    "--taskId=86cavbfx9",
    "--description=Implementation details",
    "--no-pull",
    "--branch-field-id=field-from-cli",
  ]);

  assert.equal(result.command, "start");
  assert.equal(result.taskId, "86cavbfx9");
  assert.equal(result.description, "Implementation details");
  assert.deepEqual(result.config, {
    branch: "master",
    pullRequestBranches: {
      master: "main",
      staging: "staging",
    },
    branchPrefix: "fix",
    pull: false,
    clickup: {
      branchFieldId: "field-from-cli",
    },
  });
});
