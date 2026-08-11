import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseCli, resolveSubmitSelection } from "../dist/cli.js";

test("CLI arguments are converted to a config override", () => {
  const result = parseCli([
    "start",
    "86cavbfx9",
    "remove-bottom-blur",
    "--branch=master",
    "--pr-master-branch=main",
    "--pr-staging-branch=staging",
    "--branch-prefix=fix",
    "--description=Implementation details",
    "--no-pull",
    "--branch-field-id=field-from-cli",
    "--production-pull-request-field-id=production-field-from-cli",
    "--staging-pull-request-field-id=staging-field-from-cli",
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
    featureBranch: "remove-bottom-blur",
    pull: false,
    clickup: {
      branchFieldId: "field-from-cli",
      productionPullRequestFieldId: "production-field-from-cli",
      stagingPullRequestFieldId: "staging-field-from-cli",
    },
  });
});

test("submit accepts an optional branch name or task ID", () => {
  assert.deepEqual(parseCli(["submit"]), {
    command: "submit",
    config: {},
    help: false,
    version: false,
  });
  assert.deepEqual(parseCli(["submit", "remove-bottom-blur"]), {
    command: "submit",
    submitTarget: "remove-bottom-blur",
    config: {},
    help: false,
    version: false,
  });
  assert.throws(
    () => parseCli(["start", "task-id", "branch", "extra"]),
    /Лишние позиционные аргументы/,
  );
  assert.throws(
    () => parseCli(["start", "task-id", "branch", "--feature-branch=other"]),
    /позиционное имя ветки и --feature-branch/,
  );
});

test("submit selection prefers mapped branches and falls back to task IDs", () => {
  const tasks = {
    "current-branch": "current-task",
    "remote-branch": "remote-task",
  };

  assert.deepEqual(
    resolveSubmitSelection(tasks, "current-branch", "remote-branch"),
    {
      branchName: "remote-branch",
      taskId: "remote-task",
      storeMapping: false,
    },
  );
  assert.deepEqual(resolveSubmitSelection({}, "legacy-branch", "task-id"), {
    branchName: "legacy-branch",
    taskId: "task-id",
    storeMapping: true,
  });
  assert.deepEqual(resolveSubmitSelection(tasks, "current-branch"), {
    branchName: "current-branch",
    taskId: "current-task",
    storeMapping: false,
  });
  assert.throws(
    () => resolveSubmitSelection(tasks, "current-branch", "other-task"),
    /уже связана с задачей "current-task"/,
  );
  assert.throws(
    () => resolveSubmitSelection({}, "unmapped-branch"),
    /не найден taskId/,
  );
});

test("full and short command entry points are executable", async () => {
  for (const entryPoint of ["index.js", "start.js", "submit.js"]) {
    const path = fileURLToPath(new URL(`../dist/${entryPoint}`, import.meta.url));
    assert.notEqual((await stat(path)).mode & 0o111, 0);
  }
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  assert.deepEqual(packageJson.bin, {
    "task-flow": "./dist/index.js",
    tf: "./dist/index.js",
    tfs: "./dist/start.js",
    tfsub: "./dist/submit.js",
  });
});
