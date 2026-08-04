import { parseArgs } from "node:util";
import { loadConfigFile, readClickUpToken, resolveConfig } from "./config.js";
import { TaskFlowError } from "./errors.js";
import { resolveRepository } from "./repository.js";
import type { ConfigLayer } from "./types.js";
import { startWorkflow, submitWorkflow } from "./workflow.js";

const VERSION = "1.3.1";

const HELP = `task-flow — глобальный GitHub/ClickUp workflow CLI

Использование:
  task-flow start  --branch=master --taskId=86cavbfx9
  task-flow submit --taskId=86cavbfx9
  task-flow --help

Команды:
  start    Создать или открыть <branch-prefix>/<taskId> и записать ветку в ClickUp
  submit   Push текущей ветки, найти/создать PR и записать его URL в ClickUp

Параметры:
  --taskId <id>                    ID задачи ClickUp (обязательный)
  --description <text>             Дополнительное описание pull request
  --branch <name>                  Базовая ветка
  --pr-master-branch <name>        Target PR для Deploy Flow Production
  --pr-staging-branch <name>       Target PR для Deploy Flow Staging
  --branch-prefix <prefix>         Префикс рабочей ветки
  --feature-branch <name>          Полное имя рабочей ветки
  --remote <name>                  Git remote
  --pull / --no-pull               Включить/выключить pull базовой ветки
  --draft / --no-draft             Создавать draft pull request
  --branch-field-id <id>           ClickUp field ID для веток
  --pull-request-field-id <id>     ClickUp field ID для pull requests
  --deploy-flow-field-id <id>      ClickUp field ID для Deploy Flow
  --deploy-flow-field-name <name>  Имя поля Deploy Flow
  --team-id <id>                   ClickUp team ID для custom task IDs
  --clickup-api-base-url <url>     Базовый URL ClickUp API
  -h, --help                       Показать справку
  -v, --version                    Показать версию

Конфигурация:
  ~/.config/task-flow/config.json
  CLICKUP_API_TOKEN или ~/.config/task-flow/.env
`;

interface ParsedCli {
  command?: "start" | "submit";
  taskId?: string;
  description?: string;
  config: ConfigLayer;
  help: boolean;
  version: boolean;
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseCli(argv);
  if (parsed.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (parsed.help || !parsed.command) {
    process.stdout.write(HELP);
    return;
  }
  if (!parsed.taskId?.trim()) {
    throw new TaskFlowError(
      `Для команды ${parsed.command} требуется --taskId <id>.`,
    );
  }

  const repository = await resolveRepository(process.cwd());
  const file = await loadConfigFile();
  const config = resolveConfig(
    file,
    repository.nameWithOwner,
    parsed.config,
  );
  validateResolvedConfig(config);
  const clickUpToken = await readClickUpToken();
  const workflowOptions = {
    repository,
    config,
    taskId: parsed.taskId,
    clickUpToken,
    ...(parsed.description !== undefined
      ? { pullRequestDescription: parsed.description }
      : {}),
  };

  if (parsed.command === "start") {
    const branch = await startWorkflow(workflowOptions);
    process.stdout.write(
      `Готово: ${repository.nameWithOwner}: ${branch}\n`,
    );
    return;
  }

  const pullRequests = await submitWorkflow(workflowOptions);
  process.stdout.write(`Готово: ${repository.nameWithOwner}\n`);
  for (const pullRequest of pullRequests) {
    process.stdout.write(
      `  ${pullRequest.targetBranch}: ${pullRequest.url}\n`,
    );
  }
}

export function parseCli(argv: string[]): ParsedCli {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        taskId: { type: "string" },
        description: { type: "string" },
        branch: { type: "string" },
        "pr-master-branch": { type: "string" },
        "pr-staging-branch": { type: "string" },
        "branch-prefix": { type: "string" },
        "feature-branch": { type: "string" },
        remote: { type: "string" },
        pull: { type: "boolean" },
        "no-pull": { type: "boolean" },
        draft: { type: "boolean" },
        "no-draft": { type: "boolean" },
        "branch-field-id": { type: "string" },
        "pull-request-field-id": { type: "string" },
        "deploy-flow-field-id": { type: "string" },
        "deploy-flow-field-name": { type: "string" },
        "team-id": { type: "string" },
        "clickup-api-base-url": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    throw new TaskFlowError(
      `${error instanceof Error ? error.message : String(error)}\n\n${HELP}`,
      { cause: error },
    );
  }

  const commandValue = parsed.positionals[0];
  if (
    commandValue !== undefined &&
    commandValue !== "start" &&
    commandValue !== "submit"
  ) {
    throw new TaskFlowError(
      `Неизвестная команда "${commandValue}". Используйте start или submit.`,
    );
  }
  if (parsed.positionals.length > 1) {
    throw new TaskFlowError(
      `Лишние позиционные аргументы: ${parsed.positionals.slice(1).join(" ")}`,
    );
  }

  const values = parsed.values;
  if (values.pull && values["no-pull"]) {
    throw new TaskFlowError("Нельзя одновременно указать --pull и --no-pull.");
  }
  if (values.draft && values["no-draft"]) {
    throw new TaskFlowError(
      "Нельзя одновременно указать --draft и --no-draft.",
    );
  }

  const config: ConfigLayer = {};
  setString(config, "branch", values.branch);
  const pullRequestBranches: NonNullable<
    ConfigLayer["pullRequestBranches"]
  > = {};
  setString(
    pullRequestBranches,
    "master",
    values["pr-master-branch"],
  );
  setString(
    pullRequestBranches,
    "staging",
    values["pr-staging-branch"],
  );
  if (Object.keys(pullRequestBranches).length > 0) {
    config.pullRequestBranches = pullRequestBranches;
  }
  setString(config, "branchPrefix", values["branch-prefix"]);
  setString(config, "featureBranch", values["feature-branch"]);
  setString(config, "remote", values.remote);
  if (values.pull) config.pull = true;
  if (values["no-pull"]) config.pull = false;
  if (values.draft) config.draft = true;
  if (values["no-draft"]) config.draft = false;

  const clickup: NonNullable<ConfigLayer["clickup"]> = {};
  setString(clickup, "branchFieldId", values["branch-field-id"]);
  setString(
    clickup,
    "pullRequestFieldId",
    values["pull-request-field-id"],
  );
  setString(clickup, "teamId", values["team-id"]);
  setString(clickup, "apiBaseUrl", values["clickup-api-base-url"]);
  setString(
    clickup,
    "deployFlowFieldId",
    values["deploy-flow-field-id"],
  );
  setString(
    clickup,
    "deployFlowFieldName",
    values["deploy-flow-field-name"],
  );
  if (Object.keys(clickup).length > 0) {
    config.clickup = clickup;
  }

  return {
    ...(commandValue ? { command: commandValue } : {}),
    ...(typeof values.taskId === "string"
      ? { taskId: values.taskId }
      : {}),
    ...(typeof values.description === "string"
      ? { description: values.description }
      : {}),
    config,
    help: values.help === true,
    version: values.version === true,
  };
}

function setString<T extends object, K extends keyof T>(
  object: T,
  key: K,
  value: unknown,
): void {
  if (typeof value === "string") {
    object[key] = value as T[K];
  }
}

function validateResolvedConfig(config: ReturnType<typeof resolveConfig>) {
  const requiredStrings: Array<[string, string]> = [
    ["branch", config.branch],
    ["pullRequestBranches.master", config.pullRequestBranches.master],
    ["branchPrefix", config.branchPrefix],
    ["remote", config.remote],
    ["clickup.apiBaseUrl", config.clickup.apiBaseUrl],
    ["clickup.deployFlowFieldName", config.clickup.deployFlowFieldName],
  ];
  for (const [name, value] of requiredStrings) {
    if (!value.trim()) {
      throw new TaskFlowError(`Параметр ${name} не может быть пустым.`);
    }
  }
}
