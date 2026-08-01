import { spawn } from "node:child_process";
import { TaskFlowError } from "./errors.js";
import type { CommandResult } from "./types.js";

export interface RunOptions {
  cwd: string;
  allowFailure?: boolean;
  inheritOutput?: boolean;
}

export async function runCommand(
  executable: string,
  args: readonly string[],
  options: RunOptions,
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: options.inheritOutput
        ? ["inherit", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (options.inheritOutput) {
        process.stdout.write(chunk);
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (options.inheritOutput) {
        process.stderr.write(chunk);
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      const suffix =
        error.code === "ENOENT" ? `: команда "${executable}" не найдена` : "";
      reject(
        new TaskFlowError(
          `Не удалось запустить ${formatCommand(executable, args)}${suffix}`,
          { cause: error },
        ),
      );
    });

    child.on("close", (code) => {
      const result: CommandResult = {
        stdout,
        stderr,
        exitCode: code ?? 1,
      };

      if (result.exitCode !== 0 && !options.allowFailure) {
        const details = stderr.trim() || stdout.trim();
        reject(
          new TaskFlowError(
            `Команда ${formatCommand(executable, args)} завершилась с кодом ${result.exitCode}${
              details ? `:\n${details}` : ""
            }`,
          ),
        );
        return;
      }

      resolve(result);
    });
  });
}

function formatCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args]
    .map((part) => (part.includes(" ") ? JSON.stringify(part) : part))
    .join(" ");
}
