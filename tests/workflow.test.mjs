import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  formatPullRequestBody,
  resolvePullRequestTargets,
  startWorkflow,
  submitWorkflow,
} from "../dist/workflow.js";

test("PR body contains the ClickUp ticket reference and description", () => {
  assert.equal(
    formatPullRequestBody(
      "Add some stuff",
      "https://app.clickup.com/t/86cavbfx9",
      "Implementation details",
    ),
    "Add some stuff - https://app.clickup.com/t/86cavbfx9\n\nImplementation details",
  );
});

test("Deploy Flow determines the configured PR targets", () => {
  const branches = { master: "master", staging: "staging" };
  assert.deepEqual(resolvePullRequestTargets(branches, "Staging"), [
    { role: "staging", targetBranch: "staging" },
  ]);
  assert.deepEqual(resolvePullRequestTargets(branches, "staging"), [
    { role: "staging", targetBranch: "staging" },
  ]);
  assert.deepEqual(resolvePullRequestTargets(branches, "Production"), [
    { role: "master", targetBranch: "master" },
  ]);
});

test("start and submit run from repository root and write scoped ClickUp lines", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "task-flow-workflow-"));
  const repositoryRoot = join(sandbox, "local-directory-name-is-ignored");
  const bareRemote = join(sandbox, "remote.git");
  const binDirectory = join(sandbox, "bin");
  const ghCwdLog = join(sandbox, "gh-cwd.log");
  const ghArgsLog = join(sandbox, "gh-args.log");
  const ghBodyLog = join(sandbox, "gh-body.log");
  git(sandbox, ["init", "--bare", "--quiet", bareRemote]);
  git(sandbox, ["init", "--quiet", "--initial-branch=master", repositoryRoot]);
  git(repositoryRoot, ["config", "user.name", "Task Flow Test"]);
  git(repositoryRoot, ["config", "user.email", "task-flow@example.test"]);
  await writeFile(join(repositoryRoot, "README.md"), "test\n");
  git(repositoryRoot, ["add", "README.md"]);
  git(repositoryRoot, ["commit", "--quiet", "-m", "Initial commit"]);
  git(repositoryRoot, ["remote", "add", "origin", bareRemote]);
  git(repositoryRoot, ["push", "--quiet", "-u", "origin", "master"]);
  git(repositoryRoot, ["branch", "staging"]);
  git(repositoryRoot, ["push", "--quiet", "origin", "staging"]);
  git(repositoryRoot, [
    "update-ref",
    "-d",
    "refs/remotes/origin/master",
  ]);
  git(repositoryRoot, [
    "update-ref",
    "-d",
    "refs/remotes/origin/staging",
  ]);

  await mkdir(binDirectory);
  const ghPath = join(binDirectory, "gh");
  await writeFile(
    ghPath,
    `#!/bin/sh
pwd >> "$GH_CWD_LOG"
echo "$*" >> "$GH_ARGS_LOG"
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  case "$GH_PROMOTION_MODE:$*" in
    open:*"--base staging "*)
      printf '[{"number":124,"url":"https://github.com/company/frontend/pull/124","state":"OPEN","mergedAt":null,"headRefOid":"%s","createdAt":"2026-08-04T09:00:00Z"}]\n' "$GH_MERGED_HEAD"
      ;;
    merged:*"--base staging "*)
      printf '[{"number":124,"url":"https://github.com/company/frontend/pull/124","state":"MERGED","mergedAt":"2026-08-04T10:00:00Z","headRefOid":"%s","createdAt":"2026-08-04T09:00:00Z"}]\n' "$GH_MERGED_HEAD"
      ;;
    *) printf '[]\n' ;;
  esac
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  previous=""
  for argument in "$@"; do
    if [ "$previous" = "--body" ]; then
      printf '%s' "$argument" > "$GH_BODY_LOG"
    fi
    previous="$argument"
  done
  case "$*" in
    *"--base master "*)
      git rev-parse --verify --quiet refs/remotes/origin/master || exit 4
      echo "https://github.com/company/frontend/pull/123"
      ;;
    *"--base staging "*)
      git rev-parse --verify --quiet refs/remotes/origin/staging || exit 4
      echo "https://github.com/company/frontend/pull/124"
      ;;
    *) exit 3 ;;
  esac
  exit 0
fi
exit 2
`,
  );
  await chmod(ghPath, 0o755);

  const originalPath = process.env.PATH;
  const originalLog = process.env.GH_CWD_LOG;
  const originalArgsLog = process.env.GH_ARGS_LOG;
  const originalBodyLog = process.env.GH_BODY_LOG;
  const originalPromotionMode = process.env.GH_PROMOTION_MODE;
  const originalMergedHead = process.env.GH_MERGED_HEAD;
  const originalFetch = globalThis.fetch;
  const updates = [];
  process.env.PATH = `${binDirectory}${delimiter}${originalPath ?? ""}`;
  process.env.GH_CWD_LOG = ghCwdLog;
  process.env.GH_ARGS_LOG = ghArgsLog;
  process.env.GH_BODY_LOG = ghBodyLog;
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method ?? "GET") === "POST") {
      updates.push({
        url: String(url),
        body: JSON.parse(String(init.body)),
      });
      return Response.json({});
    }
    return Response.json({
      name: "Add some stuff",
      url: "https://app.clickup.com/t/86cavbfx9",
      custom_fields: [
        {
          id: "branch-field",
          value: "company/backend: feat/86cavbfx9",
        },
        {
          id: "production-pr-field",
          value:
            "company/backend: https://github.com/company/backend/pull/44",
        },
        {
          id: "staging-pr-field",
          value:
            "company/backend: https://github.com/company/backend/pull/45",
        },
        {
          id: "deploy-flow-field",
          name: "Deploy Flow",
          value: "staging-option",
          type_config: {
            options: [
              {
                id: "staging-option",
                name: "Staging",
                orderindex: 0,
              },
            ],
          },
        },
      ],
    });
  };

  const options = {
    repository: {
      root: repositoryRoot,
      nameWithOwner: "company/frontend",
    },
    config: {
      branch: "master",
      pullRequestBranches: {
        master: "master",
        staging: "staging",
      },
      branchPrefix: "feat",
      remote: "origin",
      pull: false,
      draft: false,
      clickup: {
        apiBaseUrl: "https://clickup.example.test/api/v2",
        branchFieldId: "branch-field",
        productionPullRequestFieldId: "production-pr-field",
        stagingPullRequestFieldId: "staging-pr-field",
        deployFlowFieldName: "Deploy Flow",
      },
    },
    taskId: "86cavbfx9",
    clickUpToken: "secret",
    pullRequestDescription: "Implementation details",
  };

  try {
    assert.equal(await startWorkflow(options), "feat/86cavbfx9");
    assert.deepEqual(await submitWorkflow(options), [
      {
        role: "staging",
        targetBranch: "staging",
        url: "https://github.com/company/frontend/pull/124",
      },
    ]);

    process.env.GH_MERGED_HEAD = gitOutput(repositoryRoot, [
      "rev-parse",
      "HEAD",
    ]).trim();
    process.env.GH_PROMOTION_MODE = "open";
    assert.deepEqual(await submitWorkflow(options), [
      {
        role: "staging",
        targetBranch: "staging",
        url: "https://github.com/company/frontend/pull/124",
      },
    ]);

    process.env.GH_PROMOTION_MODE = "merged";
    assert.deepEqual(
      await submitWorkflow({
        ...options,
        confirmPromotion: async (masterBranch, stagingBranch) => {
          assert.equal(masterBranch, "master");
          assert.equal(stagingBranch, "staging");
          return false;
        },
      }),
      [],
    );
    assert.equal(updates.length, 3, "cancel must not update ClickUp");

    assert.deepEqual(
      await submitWorkflow({
        ...options,
        confirmPromotion: async (masterBranch, stagingBranch) => {
          assert.equal(masterBranch, "master");
          assert.equal(stagingBranch, "staging");
          return true;
        },
      }),
      [
        {
          role: "master",
          targetBranch: "master",
          url: "https://github.com/company/frontend/pull/123",
        },
      ],
    );

    await writeFile(join(repositoryRoot, "after-staging.txt"), "untested\n");
    git(repositoryRoot, ["add", "after-staging.txt"]);
    git(repositoryRoot, ["commit", "--quiet", "-m", "Untested change"]);
    await assert.rejects(
      submitWorkflow({
        ...options,
        confirmPromotion: async () => {
          throw new Error("prompt must not be called");
        },
      }),
      /не были протестированы на staging/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.GH_CWD_LOG;
    else process.env.GH_CWD_LOG = originalLog;
    if (originalArgsLog === undefined) delete process.env.GH_ARGS_LOG;
    else process.env.GH_ARGS_LOG = originalArgsLog;
    if (originalBodyLog === undefined) delete process.env.GH_BODY_LOG;
    else process.env.GH_BODY_LOG = originalBodyLog;
    if (originalPromotionMode === undefined)
      delete process.env.GH_PROMOTION_MODE;
    else process.env.GH_PROMOTION_MODE = originalPromotionMode;
    if (originalMergedHead === undefined) delete process.env.GH_MERGED_HEAD;
    else process.env.GH_MERGED_HEAD = originalMergedHead;
  }

  assert.equal(updates.length, 4);
  assert.equal(
    updates[0].body.value,
    [
      "company/backend: feat/86cavbfx9",
      "company/frontend: feat/86cavbfx9",
    ].join("\n"),
  );
  assert.equal(
    updates[1].body.value,
    [
      "company/backend: https://github.com/company/backend/pull/45",
      "company/frontend: https://github.com/company/frontend/pull/124",
    ].join("\n"),
  );
  assert.equal(
    updates[2].body.value,
    [
      "company/backend: https://github.com/company/backend/pull/45",
      "company/frontend: https://github.com/company/frontend/pull/124",
    ].join("\n"),
  );
  assert.equal(
    updates[3].body.value,
    [
      "company/backend: https://github.com/company/backend/pull/44",
      "company/frontend: https://github.com/company/frontend/pull/123",
    ].join("\n"),
  );
  assert.match(updates[1].url, /\/field\/staging-pr-field$/);
  assert.match(updates[2].url, /\/field\/staging-pr-field$/);
  assert.match(updates[3].url, /\/field\/production-pr-field$/);
  assert.deepEqual(
    (await readFile(ghCwdLog, "utf8")).trim().split("\n"),
    [
      repositoryRoot,
      repositoryRoot,
      repositoryRoot,
      repositoryRoot,
      repositoryRoot,
      repositoryRoot,
      repositoryRoot,
      repositoryRoot,
      repositoryRoot,
    ],
  );
  const ghCalls = (await readFile(ghArgsLog, "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("pr "));
  assert.match(ghCalls[0], /pr list .* --base staging /);
  assert.match(ghCalls[1], /pr create .* --base staging /);
  assert.match(ghCalls[2], /pr list .* --base staging /);
  assert.match(ghCalls[3], /pr list .* --base staging /);
  assert.match(ghCalls[4], /pr list .* --base master /);
  assert.match(ghCalls[5], /pr list .* --base staging /);
  assert.match(ghCalls[6], /pr list .* --base master /);
  assert.match(ghCalls[7], /pr create .* --base master /);
  assert.match(ghCalls[8], /pr list .* --base staging /);
  assert.equal(
    await readFile(ghBodyLog, "utf8"),
    "Add some stuff - https://app.clickup.com/t/86cavbfx9\n\nImplementation details",
  );
});

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function gitOutput(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
