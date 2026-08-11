#!/usr/bin/env node

import { runMain } from "./main.js";

await runMain(["commit", ...process.argv.slice(2)], "tfc");
