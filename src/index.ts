#!/usr/bin/env node

import { runCli } from "./cli.js";
import { TaskFlowError } from "./errors.js";

try {
  await runCli();
} catch (error) {
  if (error instanceof TaskFlowError) {
    process.stderr.write(`task-flow: ${error.message}\n`);
  } else {
    process.stderr.write(
      `task-flow: непредвиденная ошибка: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }

  if (process.env.TASK_FLOW_DEBUG && error instanceof Error) {
    process.stderr.write(`${error.stack ?? ""}\n`);
  }
  process.exitCode = 1;
}
