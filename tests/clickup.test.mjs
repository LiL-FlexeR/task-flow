import assert from "node:assert/strict";
import test from "node:test";
import {
  ClickUpClient,
  resolveCustomFieldValue,
  upsertRepositoryLine,
} from "../dist/clickup.js";

test("task reference returns the ClickUp task name and URL", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      name: "Add some stuff",
      url: "https://app.clickup.com/t/86cavbfx9",
    });

  try {
    const client = new ClickUpClient("secret", {
      apiBaseUrl: "https://clickup.example.test/api/v2",
      deployFlowFieldName: "Deploy Flow",
    });
    assert.deepEqual(await client.getTaskReference("86cavbfx9"), {
      name: "Add some stuff",
      url: "https://app.clickup.com/t/86cavbfx9",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ClickUp dropdown option ID is resolved to its display name", () => {
  assert.equal(
    resolveCustomFieldValue({
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
    }),
    "Staging",
  );
});

test("new repository line preserves values from other repositories", () => {
  const value = upsertRepositoryLine(
    "company/frontend: feat/86cavbfx9",
    "company/backend",
    "feat/86cavbfx9",
  );

  assert.equal(
    value,
    [
      "company/frontend: feat/86cavbfx9",
      "company/backend: feat/86cavbfx9",
    ].join("\n"),
  );
});

test("repeated run replaces only the current repository line", () => {
  const value = upsertRepositoryLine(
    [
      "company/frontend: https://github.com/company/frontend/pull/122",
      "company/backend: https://github.com/company/backend/pull/44",
    ].join("\n"),
    "company/frontend",
    "https://github.com/company/frontend/pull/123",
  );

  assert.equal(
    value,
    [
      "company/frontend: https://github.com/company/frontend/pull/123",
      "company/backend: https://github.com/company/backend/pull/44",
    ].join("\n"),
  );
});
