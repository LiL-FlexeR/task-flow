import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { commitWorkflow } from "../dist/workflow.js";

test("commit stages all changes by default and supports staged --no-verify", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "task-flow-commit-"));
  git(repositoryRoot, ["init", "--quiet", "--initial-branch=remove-bottom-blur"]);
  git(repositoryRoot, ["config", "user.name", "Task Flow Test"]);
  git(repositoryRoot, ["config", "user.email", "task-flow@example.test"]);
  await writeFile(join(repositoryRoot, "README.md"), "initial\n");
  git(repositoryRoot, ["add", "README.md"]);
  git(repositoryRoot, ["commit", "--quiet", "-m", "Initial commit"]);

  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return Response.json({
      name: "Remove bottom blur",
      url: "https://app.clickup.com/t/86cb1ewr4",
    });
  };

  const options = {
    repository: {
      root: repositoryRoot,
      nameWithOwner: "company/frontend",
    },
    config: {
      branch: "master",
      pullRequestBranches: { master: "master" },
      branchPrefix: "feat",
      remote: "origin",
      pull: false,
      draft: false,
      clickup: {
        apiBaseUrl: "https://clickup.example.test/api/v2",
        deployFlowFieldName: "Deploy Flow",
      },
    },
    taskId: "86cb1ewr4",
    clickUpToken: "secret",
  };

  try {
    await writeFile(join(repositoryRoot, "README.md"), "changed\n");
    await writeFile(join(repositoryRoot, "default-staged.txt"), "staged\n");
    assert.equal(
      await commitWorkflow({
        ...options,
        stagedOnly: false,
        noVerify: false,
      }),
      "Remove bottom blur",
    );
    assert.equal(gitOutput(repositoryRoot, ["status", "--short"]), "");
    assert.equal(
      gitOutput(repositoryRoot, ["log", "-1", "--format=%s"]).trim(),
      "Remove bottom blur",
    );

    const hookPath = join(repositoryRoot, ".git", "hooks", "pre-commit");
    await writeFile(hookPath, "#!/bin/sh\nexit 1\n");
    await chmod(hookPath, 0o755);
    await writeFile(join(repositoryRoot, "already-staged.txt"), "staged\n");
    git(repositoryRoot, ["add", "already-staged.txt"]);
    await writeFile(join(repositoryRoot, "not-staged.txt"), "not staged\n");

    await assert.rejects(
      commitWorkflow({
        ...options,
        stagedOnly: true,
        noVerify: false,
      }),
      /git commit/,
    );
    assert.equal(
      await commitWorkflow({
        ...options,
        stagedOnly: true,
        noVerify: true,
      }),
      "Remove bottom blur",
    );
    assert.equal(
      gitOutput(repositoryRoot, ["status", "--short"]),
      "?? not-staged.txt\n",
    );
    const unstagedInCommit = spawnSync(
      "git",
      ["cat-file", "-e", "HEAD:not-staged.txt"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.notEqual(unstagedInCommit.status, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 3);
  assert.ok(requests.every((url) => url.includes("/task/86cb1ewr4")));
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
