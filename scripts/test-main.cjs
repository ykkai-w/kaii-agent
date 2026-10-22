const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const tests = fs.readdirSync(path.join(root, "tests/electron"))
  .filter((name) => name.endsWith(".test.cjs") && !/dmrml/i.test(name))
  .sort()
  .map((name) => `tests/electron/${name}`);
if (process.argv.includes("--list")) {
  process.stdout.write(JSON.stringify(tests));
} else {
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
    cwd: root, stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
