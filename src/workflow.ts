import { createInterface } from "node:readline/promises";
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
  confirmPromotion?: PromotionConfirmation;
}

export type PromotionConfirmation = (
  masterBranch: string,
  stagingBranch: string,
) => Promise<boolean>;

export interface PullRequestResult {
  role: keyof PullRequestBranches;
  targetBranch: string;
  url: string;
}

interface PullRequestInfo {
  number: number;
  url: string;
  state: string;
  mergedAt: string | null;
  headRefOid: string;
  createdAt: string;
}

interface RelevantPullRequest {
  kind: "open" | "merged";
  pullRequest: PullRequestInfo;
}

interface SubmissionTarget {
  role: keyof PullRequestBranches;
  targetBranch: string;
  existing?: RelevantPullRequest;
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
  const protectedBranches = new Set([
    config.branch,
    config.pullRequestBranches.master,
    config.pullRequestBranches.staging,
  ]);
  if (protectedBranches.has(featureBranch)) {
    throw new TaskFlowError(
      `Нельзя выполнить submit из базовой/target-ветки "${featureBranch}".`,
    );
  }

  const flowTarget = targets[0];
  if (!flowTarget) {
    throw new TaskFlowError("Не удалось определить target-ветку pull request.");
  }
  const submissionTarget = await resolveSubmissionTarget(
    repository,
    config,
    featureBranch,
    flowTarget,
    options.confirmPromotion ?? confirmPromotion,
  );
  if (!submissionTarget) {
    return [];
  }

  const result: PullRequestResult = {
    role: submissionTarget.role,
    targetBranch: submissionTarget.targetBranch,
    url: submissionTarget.existing?.pullRequest.url ?? "",
  };

  if (submissionTarget.existing?.kind !== "merged") {
    await fetchPullRequestTargets(repository, config, [submissionTarget]);

    await runCommand(
      "git",
      ["push", "--set-upstream", config.remote, featureBranch],
      { cwd: repository.root, inheritOutput: true },
    );

    result.url =
      submissionTarget.existing?.pullRequest.url ??
      (await createPullRequest(
        repository,
        config,
        featureBranch,
        submissionTarget.targetBranch,
        pullRequestBody,
      ));
  }

  await clickUp.updateRepositoryField(
    taskId,
    pullRequestFieldId,
    repository.nameWithOwner,
    formatPullRequestFieldValue([result]),
  );

  return [result];
}

async function resolveSubmissionTarget(
  repository: RepositoryContext,
  config: WorkflowConfig,
  featureBranch: string,
  flowTarget: Pick<PullRequestResult, "role" | "targetBranch">,
  confirm: PromotionConfirmation,
): Promise<SubmissionTarget | undefined> {
  const flowPullRequest = await findRelevantPullRequest(
    repository,
    featureBranch,
    flowTarget.targetBranch,
  );

  if (flowTarget.role !== "staging" || flowPullRequest?.kind !== "merged") {
    return { ...flowTarget, ...(flowPullRequest ? { existing: flowPullRequest } : {}) };
  }

  const currentHead = (
    await runCommand("git", ["rev-parse", "HEAD"], { cwd: repository.root })
  ).stdout.trim();
  if (currentHead !== flowPullRequest.pullRequest.headRefOid) {
    throw new TaskFlowError(
      "Feature-ветка содержит коммиты, которые не были протестированы на staging. Создайте и смержите новый staging PR перед promotion.",
    );
  }

  const masterBranch = config.pullRequestBranches.master.trim();
  if (masterBranch === flowTarget.targetBranch) {
    throw new TaskFlowError(
      "Для promotion pullRequestBranches.master и pullRequestBranches.staging должны указывать на разные ветки.",
    );
  }
  const masterPullRequest = await findRelevantPullRequest(
    repository,
    featureBranch,
    masterBranch,
  );
  if (masterPullRequest) {
    return {
      role: "master",
      targetBranch: masterBranch,
      existing: masterPullRequest,
    };
  }

  const shouldPromote = await confirm(
    masterBranch,
    flowTarget.targetBranch,
  );
  if (!shouldPromote) {
    return undefined;
  }
  return { role: "master", targetBranch: masterBranch };
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
      ? ["staging"]
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

async function findRelevantPullRequest(
  repository: RepositoryContext,
  featureBranch: string,
  targetBranch: string,
): Promise<RelevantPullRequest | undefined> {
  const result = await runCommand(
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
      "all",
      "--limit",
      "100",
      "--json",
      "number,url,state,mergedAt,headRefOid,createdAt",
    ],
    { cwd: repository.root },
  );

  let pullRequests: PullRequestInfo[];
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) {
      throw new Error("ожидался массив");
    }
    pullRequests = parsed.filter(isPullRequestInfo);
  } catch (error) {
    throw new TaskFlowError(
      `GitHub CLI вернул некорректные данные о PR для target-ветки "${targetBranch}".`,
      { cause: error },
    );
  }

  pullRequests.sort(
    (left, right) =>
      Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );
  const open = pullRequests.find(
    (pullRequest) => pullRequest.state.toLowerCase() === "open",
  );
  if (open) {
    return { kind: "open", pullRequest: open };
  }
  const merged = pullRequests.find(
    (pullRequest) =>
      pullRequest.state.toLowerCase() === "merged" ||
      Boolean(pullRequest.mergedAt),
  );
  return merged ? { kind: "merged", pullRequest: merged } : undefined;
}

async function createPullRequest(
  repository: RepositoryContext,
  config: WorkflowConfig,
  featureBranch: string,
  targetBranch: string,
  pullRequestBody: string,
): Promise<string> {
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
  const pullRequestUrl = extractHttpUrl(createdPr.stdout);
  if (!pullRequestUrl) {
    throw new TaskFlowError(
      `GitHub CLI не вернул URL pull request для target-ветки "${targetBranch}".`,
    );
  }
  return pullRequestUrl;
}

export async function confirmPromotion(
  masterBranch: string,
  stagingBranch: string,
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new TaskFlowError(
      `PR в "${stagingBranch}" уже смержен, но promotion требует интерактивного терминала. Запустите task-flow submit вручную.`,
    );
  }

  process.stdout.write(`PR to ${stagingBranch} is already merged.\n`);
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    while (true) {
      const answer = await readline.question(
        `Press Enter to open PR to ${masterBranch} or q to cancel: `,
      );
      const normalizedAnswer = answer.trim().toLowerCase();
      if (!normalizedAnswer) {
        return true;
      }
      if (normalizedAnswer === "q") {
        return false;
      }
      process.stdout.write("Press Enter or q.\n");
    }
  } finally {
    readline.close();
  }
}

function isPullRequestInfo(value: unknown): value is PullRequestInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const pullRequest = value as Record<string, unknown>;
  return (
    typeof pullRequest.number === "number" &&
    typeof pullRequest.url === "string" &&
    isHttpUrl(pullRequest.url) &&
    typeof pullRequest.state === "string" &&
    (typeof pullRequest.mergedAt === "string" ||
      pullRequest.mergedAt === null) &&
    typeof pullRequest.headRefOid === "string" &&
    typeof pullRequest.createdAt === "string"
  );
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
