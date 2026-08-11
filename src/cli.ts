import { parseArgs } from "node:util";
import {
  getRepositoryTasks,
  loadConfigFile,
  readClickUpToken,
  resolveConfig,
  setRepositoryTask,
  writeConfigFile,
} from "./config.js";
import { TaskFlowError } from "./errors.js";
import { resolveRepository } from "./repository.js";
import type { ConfigLayer } from "./types.js";
import {
  getCurrentBranch,
  startWorkflow,
  submitWorkflow,
} from "./workflow.js";

const VERSION = "1.4.0";

const HELP = `task-flow — глобальный GitHub/ClickUp workflow CLI

Использование:
  task-flow start <taskId> [branch-name]
  task-flow submit [branch-name | taskId]
  tfs <taskId> [branch-name]
  tfsub [branch-name | taskId]
  task-flow --help

Команды:
  start    Создать или открыть <branch-prefix>/<taskId> и записать ветку в ClickUp
  submit   Push текущей ветки, найти/создать PR и записать его URL в ClickUp

Параметры:
  --taskId <id>                    ID задачи ClickUp (устаревшая форма)
  --description <text>             Дополнительное описание pull request
  --branch <name>                  Базовая ветка
  --pr-master-branch <name>        Target PR для Production/promotion
  --pr-staging-branch <name>       Target PR для Deploy Flow Staging
  --branch-prefix <prefix>         Префикс рабочей ветки
  --feature-branch <name>          Полное имя рабочей ветки
  --remote <name>                  Git remote
  --pull / --no-pull               Включить/выключить pull базовой ветки
  --draft / --no-draft             Создавать draft pull request
  --branch-field-id <id>           ClickUp field ID для веток
  --production-pull-request-field-id <id>  ClickUp field ID для production PR
  --staging-pull-request-field-id <id>     ClickUp field ID для staging PR
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
  submitTarget?: string;
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
  if (parsed.command === "start" && !parsed.taskId?.trim()) {
    throw new TaskFlowError(
      "Для команды start требуется <taskId>.",
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

  if (parsed.command === "start") {
    const taskId = parsed.taskId?.trim() ?? "";
    const featureBranch =
      config.featureBranch?.trim() || `${config.branchPrefix}/${taskId}`;
    const mappingChanged = setRepositoryTask(
      file,
      repository.nameWithOwner,
      featureBranch,
      taskId,
    );
    const clickUpToken = await readClickUpToken();
    const workflowOptions = {
      repository,
      config,
      taskId,
      clickUpToken,
      ...(parsed.description !== undefined
        ? { pullRequestDescription: parsed.description }
        : {}),
    };
    const branch = await startWorkflow(workflowOptions);
    if (mappingChanged) {
      await writeConfigFile(file);
    }
    process.stdout.write(
      `Готово: ${repository.nameWithOwner}: ${branch}\n`,
    );
    return;
  }

  const currentBranch = await getCurrentBranch(repository);
  const selection = resolveSubmitSelection(
    getRepositoryTasks(file, repository.nameWithOwner),
    currentBranch,
    parsed.submitTarget,
    parsed.taskId,
  );
  const mappingChanged = selection.storeMapping
    ? setRepositoryTask(
        file,
        repository.nameWithOwner,
        selection.branchName,
        selection.taskId,
      )
    : false;
  const clickUpToken = await readClickUpToken();
  const workflowOptions = {
    repository,
    config,
    taskId: selection.taskId,
    clickUpToken,
    submissionBranch: selection.branchName,
    pushSubmissionBranch: selection.branchName === currentBranch,
    ...(parsed.description !== undefined
      ? { pullRequestDescription: parsed.description }
      : {}),
  };
  const pullRequests = await submitWorkflow(workflowOptions);
  if (mappingChanged) {
    await writeConfigFile(file);
  }
  if (pullRequests.length === 0) {
    process.stdout.write("Cancelled.\n");
    return;
  }
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
        "production-pull-request-field-id": { type: "string" },
        "staging-pull-request-field-id": { type: "string" },
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
    "productionPullRequestFieldId",
    values["production-pull-request-field-id"],
  );
  setString(
    clickup,
    "stagingPullRequestFieldId",
    values["staging-pull-request-field-id"],
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

  let taskId =
    typeof values.taskId === "string" ? values.taskId : undefined;
  let submitTarget: string | undefined;
  if (commandValue === "start") {
    if (parsed.positionals.length > 3) {
      throw new TaskFlowError(
        `Лишние позиционные аргументы: ${parsed.positionals.slice(3).join(" ")}`,
      );
    }
    const positionalTaskId = parsed.positionals[1];
    const positionalBranch = parsed.positionals[2];
    if (positionalTaskId !== undefined && taskId !== undefined) {
      throw new TaskFlowError(
        "Нельзя одновременно передать позиционный taskId и --taskId.",
      );
    }
    taskId = positionalTaskId ?? taskId;
    if (positionalBranch !== undefined) {
      if (config.featureBranch !== undefined) {
        throw new TaskFlowError(
          "Нельзя одновременно передать позиционное имя ветки и --feature-branch.",
        );
      }
      config.featureBranch = positionalBranch;
    }
  } else if (commandValue === "submit") {
    if (parsed.positionals.length > 2) {
      throw new TaskFlowError(
        `Лишние позиционные аргументы: ${parsed.positionals.slice(2).join(" ")}`,
      );
    }
    submitTarget = parsed.positionals[1];
    if (submitTarget !== undefined && taskId !== undefined) {
      throw new TaskFlowError(
        "Нельзя одновременно передать branch/taskId и --taskId.",
      );
    }
  } else if (parsed.positionals.length > 1) {
    throw new TaskFlowError(
      `Лишние позиционные аргументы: ${parsed.positionals.slice(1).join(" ")}`,
    );
  }

  return {
    ...(commandValue ? { command: commandValue } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(submitTarget !== undefined ? { submitTarget } : {}),
    ...(typeof values.description === "string"
      ? { description: values.description }
      : {}),
    config,
    help: values.help === true,
    version: values.version === true,
  };
}

export interface SubmitSelection {
  branchName: string;
  taskId: string;
  storeMapping: boolean;
}

export function resolveSubmitSelection(
  tasks: Readonly<Record<string, string>>,
  currentBranch: string,
  submitTarget?: string,
  explicitTaskId?: string,
): SubmitSelection {
  const normalizedCurrentBranch = currentBranch.trim();
  const normalizedTarget = submitTarget?.trim();
  const normalizedExplicitTaskId = explicitTaskId?.trim();

  if (normalizedTarget) {
    const mappedTaskId = tasks[normalizedTarget]?.trim();
    if (mappedTaskId) {
      return {
        branchName: normalizedTarget,
        taskId: mappedTaskId,
        storeMapping: false,
      };
    }
  }

  const taskId = normalizedExplicitTaskId || normalizedTarget;
  if (taskId) {
    const currentTaskId = tasks[normalizedCurrentBranch]?.trim();
    if (currentTaskId && currentTaskId !== taskId) {
      throw new TaskFlowError(
        `Ветка "${normalizedCurrentBranch}" уже связана с задачей "${currentTaskId}".`,
      );
    }
    return {
      branchName: normalizedCurrentBranch,
      taskId,
      storeMapping: !currentTaskId,
    };
  }

  const currentTaskId = tasks[normalizedCurrentBranch]?.trim();
  if (!currentTaskId) {
    throw new TaskFlowError(
      `Для ветки "${normalizedCurrentBranch}" не найден taskId в repositories[repo].tasks. Передайте branchName или taskId явно.`,
    );
  }
  return {
    branchName: normalizedCurrentBranch,
    taskId: currentTaskId,
    storeMapping: false,
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
