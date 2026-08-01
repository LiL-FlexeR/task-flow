import { TaskFlowError } from "./errors.js";
import type { ClickUpConfig } from "./types.js";

export interface ClickUpCustomField {
  id: string;
  name?: string;
  value?: unknown;
  type_config?: {
    options?: Array<{
      id?: string;
      name?: string;
      orderindex?: number | string;
    }>;
  };
}

interface ClickUpTask {
  name?: string;
  url?: string;
  custom_fields?: ClickUpCustomField[];
}

export interface ClickUpTaskReference {
  name: string;
  url: string;
}

export class ClickUpClient {
  readonly #token: string;
  readonly #config: ClickUpConfig;
  readonly #tasks = new Map<string, Promise<ClickUpTask>>();

  constructor(token: string, config: ClickUpConfig) {
    this.#token = token;
    this.#config = config;
  }

  async updateRepositoryField(
    taskId: string,
    fieldId: string,
    nameWithOwner: string,
    repositoryValue: string,
  ): Promise<void> {
    const task = await this.#getTask(taskId);
    const currentField = task.custom_fields?.find(
      (field) => field.id === fieldId,
    );
    const currentValue =
      typeof currentField?.value === "string" ? currentField.value : "";
    const value = upsertRepositoryLine(
      currentValue,
      nameWithOwner,
      repositoryValue,
    );

    await this.#request(
      this.#taskPath(
        `/task/${encodeURIComponent(taskId)}/field/${encodeURIComponent(fieldId)}`,
      ),
      {
        method: "POST",
        body: JSON.stringify({ value }),
      },
    );
  }

  async getCustomFieldValue(
    taskId: string,
    selector: { fieldId?: string; fieldName: string },
  ): Promise<string> {
    const task = await this.#getTask(taskId);
    const field = task.custom_fields?.find((candidate) =>
      selector.fieldId
        ? candidate.id === selector.fieldId
        : candidate.name?.trim().toLowerCase() ===
          selector.fieldName.trim().toLowerCase(),
    );

    if (!field) {
      const description = selector.fieldId
        ? `ID "${selector.fieldId}"`
        : `именем "${selector.fieldName}"`;
      throw new TaskFlowError(
        `В задаче ClickUp не найден custom field с ${description}.`,
      );
    }

    const value = resolveCustomFieldValue(field);
    if (!value) {
      throw new TaskFlowError(
        `Custom field ClickUp "${field.name ?? field.id}" не имеет значения.`,
      );
    }
    return value;
  }

  async getTaskReference(taskId: string): Promise<ClickUpTaskReference> {
    const task = await this.#getTask(taskId);
    const name = task.name?.trim();
    const url = task.url?.trim();
    if (!name || !url) {
      throw new TaskFlowError(
        "ClickUp API не вернул название или URL задачи, необходимые для описания PR.",
      );
    }
    return { name, url };
  }

  #getTask(taskId: string): Promise<ClickUpTask> {
    const existing = this.#tasks.get(taskId);
    if (existing) {
      return existing;
    }
    const task = this.#request<ClickUpTask>(
      this.#taskPath(`/task/${encodeURIComponent(taskId)}`),
    );
    this.#tasks.set(taskId, task);
    return task;
  }

  #taskPath(path: string): string {
    const url = new URL(
      `${this.#config.apiBaseUrl.replace(/\/+$/, "")}${path}`,
    );
    if (this.#config.teamId) {
      url.searchParams.set("custom_task_ids", "true");
      url.searchParams.set("team_id", this.#config.teamId);
    }
    return url.toString();
  }

  async #request<T = unknown>(
    url: string,
    init: RequestInit = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          Authorization: this.#token,
          "Content-Type": "application/json",
          ...init.headers,
        },
      });
    } catch (error) {
      throw new TaskFlowError("Не удалось подключиться к ClickUp API", {
        cause: error,
      });
    }

    const text = await response.text();
    if (!response.ok) {
      throw new TaskFlowError(
        `ClickUp API вернул ${response.status} ${response.statusText}${
          text ? `: ${text}` : ""
        }`,
      );
    }

    if (!text) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new TaskFlowError("ClickUp API вернул некорректный JSON", {
        cause: error,
      });
    }
  }
}

export function resolveCustomFieldValue(
  field: ClickUpCustomField,
): string | undefined {
  const options = field.type_config?.options ?? [];
  const rawValue = field.value;

  if (typeof rawValue === "string" || typeof rawValue === "number") {
    const normalizedValue = String(rawValue).trim();
    const matchingOption = options.find(
      (option, index) =>
        option.id === normalizedValue ||
        option.name?.trim().toLowerCase() === normalizedValue.toLowerCase() ||
        String(option.orderindex) === normalizedValue ||
        String(index) === normalizedValue,
    );
    return matchingOption?.name?.trim() || normalizedValue || undefined;
  }

  if (isRecord(rawValue)) {
    for (const key of ["name", "label", "value"]) {
      const nestedValue = rawValue[key];
      if (
        typeof nestedValue === "string" ||
        typeof nestedValue === "number"
      ) {
        return String(nestedValue).trim() || undefined;
      }
    }
  }

  return undefined;
}

export function upsertRepositoryLine(
  currentValue: string,
  nameWithOwner: string,
  repositoryValue: string,
): string {
  const prefix = `${nameWithOwner}:`;
  const replacement = `${prefix} ${repositoryValue}`;
  const lines = currentValue
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const result: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      if (!replaced) {
        result.push(replacement);
        replaced = true;
      }
      continue;
    }
    result.push(line);
  }

  if (!replaced) {
    result.push(replacement);
  }
  return result.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
