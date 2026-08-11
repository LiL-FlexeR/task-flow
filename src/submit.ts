#!/usr/bin/env node

import { runMain } from "./main.js";

await runMain(["submit", ...process.argv.slice(2)], "tfsub");
