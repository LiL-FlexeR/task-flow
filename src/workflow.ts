import { ClickUpClient } from "./clickup.js";
import { TaskFlowError } from "./errors.js";
import { runCommand } from "./process.js";
import type {
  PullRequestBranches,
  RepositoryContext,
  WorkflowConfig,
} from "./types.js";

export interface WorkflowOptions {
  repository: RepositoryContext;
  config: WorkflowConfig;
  taskId: string;
  clickUpToken: string;
  pullRequestDescription?: string;
}

export interface PullRequestResult {
  role: keyof PullRequestBranches;
  targetBranch: string;
  url: string;
}

export async function startWorkflow(
  options: WorkflowOptions,
): Promise<string> {
  const { repository, config, taskId } = options;
  const branchFieldId = requireFieldId(
    config.clickup.branchFieldId,
    "branchFieldId",
  );
  const featureBranch =
    config.featureBranch ?? `${config.branchPrefix}/${taskId}`;

  await runCommand("git", ["check-ref-format", "--branch", featureBranch], {
    cwd: repository.root,
  });

  const localBranch = await runCommand(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${featureBranch}`],
    { cwd: repository.root, allowFailure: true },
  );

  if (localBranch.exitCode === 0) {
    await runCommand("git", ["switch", featureBranch], {
      cwd: repository.root,
      inheritOutput: true,
    });
  } else {
    await runCommand("git", ["switch", config.branch], {
      cwd: repository.root,
      inheritOutput: true,
    });
    if (config.pull) {
      await runCommand(
        "git",
        ["pull", "--ff-only", config.remote, config.branch],
        { cwd: repository.root, inheritOutput: true },
      );
    }
    await runCommand("git", ["switch", "-c", featureBranch], {
      cwd: repository.root,
      inheritOutput: true,
    });
  }

  const clickUp = new ClickUpClient(options.clickUpToken, config.clickup);
  await clickUp.updateRepositoryField(
    taskId,
    branchFieldId,
    repository.nameWithOwner,
    featureBranch,
  );

  return featureBranch;
}

export async function submitWorkflow(
  options: WorkflowOptions,
): Promise<PullRequestResult[]> {
  const { repository, config, taskId } = options;
  const pullRequestFieldId = requireFieldId(
    config.clickup.pullRequestFieldId,
    "pullRequestFieldId",
  );
  const clickUp = new ClickUpClient(options.clickUpToken, config.clickup);
  const deployFlow = await clickUp.getCustomFieldValue(taskId, {
    ...(config.clickup.deployFlowFieldId
      ? { fieldId: config.clickup.deployFlowFieldId }
      : {}),
    fieldName: config.clickup.deployFlowFieldName,
  });
  const targets = resolvePullRequestTargets(
    config.pullRequestBranches,
    deployFlow,
  );
  const taskReference = await clickUp.getTaskReference(taskId);
  const pullRequestBody = formatPullRequestBody(
    taskReference.name,
    taskReference.url,
    options.pullRequestDescription,
  );

  const branchResult = await runCommand(
    "git",
    ["branch", "--show-current"],
    { cwd: repository.root },
  );
  const featureBranch = branchResult.stdout.trim();
  if (!featureBranch) {
    throw new TaskFlowError(
      "HEAD находится в detached-состоянии. Переключитесь на ветку перед submit.",
    );
  }
  if (
    featureBranch === config.branch ||
    targets.some((target) => target.targetBranch === featureBranch)
  ) {
    throw new TaskFlowError(
      `Нельзя выполнить submit из базовой/target-ветки "${featureBranch}".`,
    );
  }

  await fetchPullRequestTargets(repository, config, targets);

  await runCommand(
    "git",
    ["push", "--set-upstream", config.remote, featureBranch],
    { cwd: repository.root, inheritOutput: true },
  );

  const pullRequests: PullRequestResult[] = [];
  for (const target of targets) {
    const url = await findOrCreatePullRequest(
      repository,
      config,
      featureBranch,
      target.targetBranch,
      pullRequestBody,
    );
    pullRequests.push({ ...target, url });
  }

  await clickUp.updateRepositoryField(
    taskId,
    pullRequestFieldId,
    repository.nameWithOwner,
    formatPullRequestFieldValue(pullRequests),
  );

  return pullRequests;
}

async function fetchPullRequestTargets(
  repository: RepositoryContext,
  config: WorkflowConfig,
  targets: Array<Pick<PullRequestResult, "targetBranch">>,
): Promise<void> {
  for (const { targetBranch } of targets) {
    await runCommand("git", ["check-ref-format", "--branch", targetBranch], {
      cwd: repository.root,
    });
  }

  const refspecs = targets.map(
    ({ targetBranch }) =>
      `refs/heads/${targetBranch}:refs/remotes/${config.remote}/${targetBranch}`,
  );
  await runCommand(
    "git",
    ["fetch", "--no-tags", config.remote, ...refspecs],
    { cwd: repository.root, inheritOutput: true },
  );
}

export function resolvePullRequestTargets(
  branches: PullRequestBranches,
  deployFlow: string,
): Array<Pick<PullRequestResult, "role" | "targetBranch">> {
  const normalizedFlow = deployFlow.trim().toLowerCase();
  const requestedRoles: Array<keyof PullRequestBranches> =
    normalizedFlow === "staging"
      ? ["master", "staging"]
      : normalizedFlow === "production"
        ? ["master"]
        : [];

  if (requestedRoles.length === 0) {
    throw new TaskFlowError(
      `Неподдерживаемое значение Deploy Flow "${deployFlow}". Ожидается Staging или Production.`,
    );
  }

  const targets: Array<
    Pick<PullRequestResult, "role" | "targetBranch">
  > = [];
  for (const role of requestedRoles) {
    const targetBranch = branches[role]?.trim();
    if (!targetBranch) {
      throw new TaskFlowError(
        `Для Deploy Flow "${deployFlow}" не настроен pullRequestBranches.${role}.`,
      );
    }
    if (!targets.some((target) => target.targetBranch === targetBranch)) {
      targets.push({ role, targetBranch });
    }
  }
  return targets;
}

export function formatPullRequestFieldValue(
  pullRequests: PullRequestResult[],
): string {
  if (pullRequests.length === 1) {
    return pullRequests[0]?.url ?? "";
  }
  return pullRequests
    .map(({ targetBranch, url }) => `${targetBranch}: ${url}`)
    .join("; ");
}

export function formatPullRequestBody(
  taskName: string,
  taskUrl: string,
  description?: string,
): string {
  const ticketReference = `${taskName.trim()} - ${taskUrl.trim()}`;
  const normalizedDescription = description?.trim();
  return normalizedDescription
    ? `${ticketReference}\n\n${normalizedDescription}`
    : ticketReference;
}

async function findOrCreatePullRequest(
  repository: RepositoryContext,
  config: WorkflowConfig,
  featureBranch: string,
  targetBranch: string,
  pullRequestBody: string,
): Promise<string> {
  const existingPr = await runCommand(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repository.nameWithOwner,
      "--head",
      featureBranch,
      "--base",
      targetBranch,
      "--state",
      "open",
      "--json",
      "url",
      "--jq",
      ".[0].url",
    ],
    { cwd: repository.root, allowFailure: true },
  );

  let pullRequestUrl = existingPr.stdout.trim();
  if (existingPr.exitCode !== 0 || !isHttpUrl(pullRequestUrl)) {
    const args = [
      "pr",
      "create",
      "--repo",
      repository.nameWithOwner,
      "--base",
      targetBranch,
      "--head",
      featureBranch,
      "--fill",
      "--body",
      pullRequestBody,
    ];
    if (config.draft) {
      args.push("--draft");
    }

    const createdPr = await runCommand("gh", args, {
      cwd: repository.root,
      inheritOutput: true,
    });
    pullRequestUrl = extractHttpUrl(createdPr.stdout);
  }

  if (!pullRequestUrl) {
    throw new TaskFlowError(
      `GitHub CLI не вернул URL pull request для target-ветки "${targetBranch}".`,
    );
  }
  return pullRequestUrl;
}

function requireFieldId(
  fieldId: string | undefined,
  fieldName: string,
): string {
  if (!fieldId?.trim()) {
    throw new TaskFlowError(
      `Не настроен defaults.clickup.${fieldName} (или override репозитория/CLI).`,
    );
  }
  return fieldId;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value);
}

function extractHttpUrl(value: string): string {
  return value.match(/https?:\/\/\S+/i)?.[0] ?? "";
}
