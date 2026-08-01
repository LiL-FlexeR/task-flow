import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  parseNameWithOwner,
  resolveRepository,
} from "../dist/repository.js";

test("origin URL is parsed without using the local directory name", () => {
  assert.equal(
    parseNameWithOwner("git@github.com:company/frontend.git"),
    "company/frontend",
  );
  assert.equal(
    parseNameWithOwner("https://github.com/company/backend.git"),
    "company/backend",
  );
  assert.equal(
    parseNameWithOwner("ssh://git@github.com/company/admin.git"),
    "company/admin",
  );
});

test("repository root is resolved from a nested directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-flow-repository-"));
  const nested = join(root, "packages", "app", "src");
  await mkdir(nested, { recursive: true });
  git(root, ["init", "--quiet"]);
  git(root, [
    "remote",
    "add",
    "origin",
    "git@github.com:company/frontend.git",
  ]);

  const repository = await resolveRepository(nested);
  assert.equal(repository.root, root);
  assert.equal(repository.nameWithOwner, "company/frontend");
});

test("running outside a Git repository produces a clear error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "task-flow-not-git-"));
  await assert.rejects(
    resolveRepository(directory),
    /не находится внутри Git-репозитория/,
  );
});

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
