#!/usr/bin/env node

import { runMain } from "./main.js";

await runMain(["start", ...process.argv.slice(2)], "tfs");
