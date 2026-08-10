import assert from "node:assert/strict";
import test from "node:test";
import { parseEnv, resolveConfig } from "../dist/config.js";

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
