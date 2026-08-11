import { runCli } from "./cli.js";
import { TaskFlowError } from "./errors.js";

export async function runMain(
  argv: string[],
  commandName = "task-flow",
): Promise<void> {
  try {
    await runCli(argv);
  } catch (error) {
    if (error instanceof TaskFlowError) {
      process.stderr.write(`${commandName}: ${error.message}\n`);
    } else {
      process.stderr.write(
        `${commandName}: непредвиденная ошибка: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }

    if (process.env.TASK_FLOW_DEBUG && error instanceof Error) {
      process.stderr.write(`${error.stack ?? ""}\n`);
    }
    process.exitCode = 1;
  }
}
