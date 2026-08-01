import { TaskFlowError } from "./errors.js";
import { runCommand } from "./process.js";
import type { RepositoryContext } from "./types.js";

const NAME_WITH_OWNER_PATTERN = /^[^/\s]+\/[^/\s]+$/;

export async function resolveRepository(
  initialCwd = process.cwd(),
): Promise<RepositoryContext> {
  const rootResult = await runCommand(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: initialCwd, allowFailure: true },
  );

  if (rootResult.exitCode !== 0 || !rootResult.stdout.trim()) {
    throw new TaskFlowError(
      `Текущая директория не находится внутри Git-репозитория: ${initialCwd}`,
    );
  }

  const root = rootResult.stdout.trim();
  const ghResult = await runCommand(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    { cwd: root, allowFailure: true },
  ).catch(() => undefined);

  const ghName = ghResult?.exitCode === 0 ? ghResult.stdout.trim() : "";
  if (NAME_WITH_OWNER_PATTERN.test(ghName)) {
    return { root, nameWithOwner: ghName };
  }

  const originResult = await runCommand(
    "git",
    ["remote", "get-url", "origin"],
    { cwd: root, allowFailure: true },
  );

  if (originResult.exitCode !== 0 || !originResult.stdout.trim()) {
    throw new TaskFlowError(
      "Не удалось определить репозиторий: gh repo view недоступен, а remote origin не настроен.",
    );
  }

  const nameWithOwner = parseNameWithOwner(originResult.stdout.trim());
  if (!nameWithOwner) {
    throw new TaskFlowError(
      `Не удалось преобразовать origin URL в owner/repository: ${originResult.stdout.trim()}`,
    );
  }

  return { root, nameWithOwner };
}

export function parseNameWithOwner(remoteUrl: string): string | undefined {
  let path: string;

  try {
    const url = new URL(remoteUrl);
    path = url.pathname;
  } catch {
    const scpLike = remoteUrl.match(/^(?:[^@/\s]+@)?[^:/\s]+:(.+)$/);
    if (!scpLike?.[1]) {
      return undefined;
    }
    path = scpLike[1];
  }

  const segments = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);

  if (segments.length < 2) {
    return undefined;
  }

  const owner = segments.at(-2);
  const repository = segments.at(-1);
  if (!owner || !repository || /\s/.test(owner) || /\s/.test(repository)) {
    return undefined;
  }

  return `${owner}/${repository}`;
}
