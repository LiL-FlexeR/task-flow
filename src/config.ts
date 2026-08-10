import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { TaskFlowError } from "./errors.js";
import type {
  ConfigFile,
  ConfigLayer,
  WorkflowConfig,
} from "./types.js";

export const CONFIG_DIRECTORY = join(homedir(), ".config", "task-flow");
export const CONFIG_PATH = join(CONFIG_DIRECTORY, "config.json");
export const ENV_PATH = join(CONFIG_DIRECTORY, ".env");

const BUILTIN_DEFAULTS: Omit<WorkflowConfig, "pullRequestBranches"> = {
  branch: "master",
  branchPrefix: "feat",
  remote: "origin",
  pull: true,
  draft: false,
  clickup: {
    apiBaseUrl: "https://api.clickup.com/api/v2",
    deployFlowFieldName: "Deploy Flow",
  },
};

export async function loadConfigFile(path = CONFIG_PATH): Promise<ConfigFile> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new TaskFlowError(`Не удалось прочитать конфигурацию ${path}`, {
      cause: error,
    });
  }

  try {
    const value: unknown = JSON.parse(contents);
    if (!isPlainObject(value)) {
      throw new Error("корневое значение должно быть объектом");
    }
    validateConfigFile(value, path);
    return value as ConfigFile;
  } catch (error) {
    throw new TaskFlowError(
      `Некорректный JSON или структура конфигурации в ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

export function resolveConfig(
  file: ConfigFile,
  nameWithOwner: string,
  cli: ConfigLayer,
): WorkflowConfig {
  const repository = file.repositories?.[nameWithOwner] ?? {};
  return mergeLayers(file.defaults ?? {}, repository, cli);
}

export async function readClickUpToken(
  environment: NodeJS.ProcessEnv = process.env,
  envPath = ENV_PATH,
): Promise<string> {
  const processToken = environment.CLICKUP_API_TOKEN?.trim();
  if (processToken) {
    return processToken;
  }

  let contents: string;
  try {
    contents = await readFile(envPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw missingTokenError(envPath);
    }
    throw new TaskFlowError(`Не удалось прочитать ${envPath}`, { cause: error });
  }

  const values = parseEnv(contents);
  const fileToken = values.CLICKUP_API_TOKEN?.trim();
  if (!fileToken) {
    throw missingTokenError(envPath);
  }
  return fileToken;
}

export function parseEnv(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match?.[1]) {
      continue;
    }

    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    result[match[1]] = value.replace(/\\n/g, "\n");
  }
  return result;
}

function mergeLayers(
  ...layers: ConfigLayer[]
): WorkflowConfig {
  const result: WorkflowConfig = {
    ...structuredClone(BUILTIN_DEFAULTS),
    pullRequestBranches: {
      master: BUILTIN_DEFAULTS.branch,
    },
  };
  let configuredPullRequestBranches: Partial<
    WorkflowConfig["pullRequestBranches"]
  > = {};
  for (const layer of layers) {
    for (const key of [
      "branch",
      "branchPrefix",
      "remote",
      "pull",
      "draft",
      "featureBranch",
    ] as const) {
      const value = layer[key];
      if (value !== undefined) {
        Object.assign(result, { [key]: value });
      }
    }
    if (layer.pullRequestBranches) {
      configuredPullRequestBranches = {
        ...configuredPullRequestBranches,
        ...layer.pullRequestBranches,
      };
    }
    if (layer.clickup) {
      result.clickup = { ...result.clickup, ...layer.clickup };
    }
  }
  result.pullRequestBranches = {
    master: configuredPullRequestBranches.master ?? result.branch,
    ...(configuredPullRequestBranches.staging !== undefined
      ? { staging: configuredPullRequestBranches.staging }
      : {}),
  };
  return result;
}

function validateConfigFile(
  value: Record<string, unknown>,
  path: string,
): void {
  if (value.defaults !== undefined) {
    validateLayer(value.defaults, `${path}: defaults`);
  }

  if (value.repositories !== undefined) {
    if (!isPlainObject(value.repositories)) {
      throw new Error(`${path}: repositories должен быть объектом`);
    }
    for (const [repository, layer] of Object.entries(value.repositories)) {
      if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
        throw new Error(
          `${path}: ключ repositories "${repository}" должен иметь формат owner/repository`,
        );
      }
      validateLayer(layer, `${path}: repositories["${repository}"]`);
    }
  }
}

function validateLayer(value: unknown, location: string): void {
  if (!isPlainObject(value)) {
    throw new Error(`${location} должен быть объектом`);
  }

  for (const key of [
    "branch",
    "branchPrefix",
    "remote",
    "featureBranch",
  ]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`${location}.${key} должен быть строкой`);
    }
  }
  for (const key of ["pull", "draft"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error(`${location}.${key} должен быть boolean`);
    }
  }
  if (value.pullRequestBranches !== undefined) {
    if (!isPlainObject(value.pullRequestBranches)) {
      throw new Error(`${location}.pullRequestBranches должен быть объектом`);
    }
    for (const key of ["master", "staging"]) {
      if (
        value.pullRequestBranches[key] !== undefined &&
        typeof value.pullRequestBranches[key] !== "string"
      ) {
        throw new Error(
          `${location}.pullRequestBranches.${key} должен быть строкой`,
        );
      }
    }
  }
  if (value.clickup !== undefined) {
    if (!isPlainObject(value.clickup)) {
      throw new Error(`${location}.clickup должен быть объектом`);
    }
    for (const key of [
      "apiBaseUrl",
      "branchFieldId",
      "productionPullRequestFieldId",
      "stagingPullRequestFieldId",
      "deployFlowFieldId",
      "deployFlowFieldName",
      "teamId",
    ]) {
      if (
        value.clickup[key] !== undefined &&
        typeof value.clickup[key] !== "string"
      ) {
        throw new Error(`${location}.clickup.${key} должен быть строкой`);
      }
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missingTokenError(envPath: string): TaskFlowError {
  return new TaskFlowError(
    `CLICKUP_API_TOKEN не задан. Экспортируйте переменную окружения или добавьте её в ${envPath}`,
  );
}
