import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getRepositoryTasks,
  loadConfigFile,
  parseEnv,
  resolveConfig,
  setRepositoryTask,
  writeConfigFile,
} from "../dist/config.js";

test("config precedence is CLI > repository > defaults", () => {
  const config = resolveConfig(
    {
      defaults: {
        branch: "main",
        pullRequestBranches: {
          master: "main",
          staging: "staging-default",
        },
        branchPrefix: "feature",
        remote: "upstream",
        clickup: {
          branchFieldId: "default-branch-field",
          productionPullRequestFieldId: "default-production-pr-field",
          stagingPullRequestFieldId: "default-staging-pr-field",
        },
      },
      repositories: {
        "company/frontend": {
          branch: "develop",
          pullRequestBranches: {
            staging: "release",
          },
          clickup: {
            branchFieldId: "frontend-branch-field",
            stagingPullRequestFieldId: "frontend-staging-pr-field",
          },
        },
      },
    },
    "company/frontend",
    {
      branch: "release",
      pullRequestBranches: {
        master: "production",
      },
      clickup: {
        branchFieldId: "cli-branch-field",
        productionPullRequestFieldId: "cli-production-pr-field",
      },
    },
  );

  assert.equal(config.branch, "release");
  assert.deepEqual(config.pullRequestBranches, {
    master: "production",
    staging: "release",
  });
  assert.equal(config.branchPrefix, "feature");
  assert.equal(config.remote, "upstream");
  assert.equal(config.clickup.branchFieldId, "cli-branch-field");
  assert.equal(
    config.clickup.productionPullRequestFieldId,
    "cli-production-pr-field",
  );
  assert.equal(
    config.clickup.stagingPullRequestFieldId,
    "frontend-staging-pr-field",
  );
});

test("another repository does not receive repository-specific values", () => {
  const config = resolveConfig(
    {
      defaults: { branch: "main" },
      repositories: {
        "company/frontend": { branch: "develop" },
      },
    },
    "company/backend",
    {},
  );

  assert.equal(config.branch, "main");
  assert.deepEqual(config.pullRequestBranches, { master: "main" });
});

test("repository-specific PR branch overrides the default", () => {
  const config = resolveConfig(
    {
      defaults: {
        branch: "master",
        pullRequestBranches: {
          master: "master",
          staging: "develop",
        },
      },
      repositories: {
        "company/frontend": {
          pullRequestBranches: {
            staging: "staging",
          },
        },
      },
    },
    "company/frontend",
    {},
  );

  assert.equal(config.branch, "master");
  assert.deepEqual(config.pullRequestBranches, {
    master: "master",
    staging: "staging",
  });
});

test("repository task mappings are persisted and cannot be reassigned", async () => {
  const file = {
    repositories: {
      "company/backend": {
        tasks: { "existing-branch": "old-task" },
      },
    },
  };

  assert.equal(
    setRepositoryTask(
      file,
      "company/frontend",
      "remove-bottom-blur",
      "86cb1ewr4",
    ),
    true,
  );
  assert.equal(
    setRepositoryTask(
      file,
      "company/frontend",
      "remove-bottom-blur",
      "86cb1ewr4",
    ),
    false,
  );
  assert.throws(
    () =>
      setRepositoryTask(
        file,
        "company/frontend",
        "remove-bottom-blur",
        "another-task",
      ),
    /уже связана с задачей "86cb1ewr4"/,
  );

  const directory = await mkdtemp(join(tmpdir(), "task-flow-config-"));
  const path = join(directory, "nested", "config.json");
  await writeConfigFile(file, path);
  const saved = await loadConfigFile(path);
  assert.deepEqual(getRepositoryTasks(saved, "company/frontend"), {
    "remove-bottom-blur": "86cb1ewr4",
  });
  assert.deepEqual(getRepositoryTasks(saved, "company/backend"), {
    "existing-branch": "old-task",
  });
});

test(".env parser supports export, quotes, and comments", () => {
  assert.deepEqual(
    parseEnv(`
      # ignored
      export CLICKUP_API_TOKEN="secret-token"
      OTHER=value # inline comment
    `),
    {
      CLICKUP_API_TOKEN: "secret-token",
      OTHER: "value",
    },
  );
});
