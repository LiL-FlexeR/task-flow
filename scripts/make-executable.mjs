import { chmod } from "node:fs/promises";

await Promise.all(
  ["index.js", "start.js", "submit.js"].map((file) =>
    chmod(new URL(`../dist/${file}`, import.meta.url), 0o755),
  ),
);
