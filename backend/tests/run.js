/**
 * Cross-platform test runner. Replaces the original bash script, which only
 * worked on Mac/Linux - Windows has no /bin/bash and no /tmp.
 *
 * Everything here uses Node's own APIs (os.tmpdir(), child_process, path.join)
 * so the same command works on Windows, macOS, and Linux.
 *
 * Run with:  npm test
 */
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");

const BACKEND = path.join(__dirname, "..");
const SERVER = path.join(BACKEND, "dist", "index.js");
const PORT = 6399;
const API_PORT = 8099;

/** npx is npx.cmd on Windows; without the extension spawn can't find it. */
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

function tmp(name) {
  return path.join(os.tmpdir(), name);
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Polls the port instead of sleeping a fixed time - faster and less flaky. */
function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.on("connect", () => { socket.destroy(); resolve(); });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} never opened`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function startServer(dataDir) {
  rmrf(dataDir);
  const proc = spawn(process.execPath, [SERVER], {
    cwd: BACKEND,
    env: {
      ...process.env,
      cacheforge_DATA_DIR: dataDir,
      cacheforge_PORT: String(PORT),
      cacheforge_API_PORT: String(API_PORT),
    },
    stdio: "ignore",
  });
  return proc;
}

function runTest(file) {
  const res = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: "inherit",
    cwd: BACKEND,
  });
  return res.status === 0;
}

async function main() {
  let allPassed = true;

  console.log("Building...");
  const build = spawnSync(NPX, ["tsc", "-p", "tsconfig.json"], {
    cwd: BACKEND,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (build.status !== 0) {
    console.error("Build failed.");
    process.exit(1);
  }

  // --- Suites that share one server ---
  for (const [label, file] of [
    ["commands", "commands.test.js"],
    ["pub/sub", "pubsub.test.js"],
    ["dependency graph", "depgraph.test.js"],
  ]) {
    console.log(`\n=== ${label} ===`);
    const dataDir = tmp(`cacheforge-test-${label.replace("/", "")}`);
    const server = startServer(dataDir);
    try {
      await waitForPort(PORT);
      if (!runTest(file)) allPassed = false;
    } catch (err) {
      console.error(`  could not start server: ${err.message}`);
      allPassed = false;
    } finally {
      server.kill();
      // Give the OS a moment to release the listening socket before the
      // next suite tries to bind the same port.
      await new Promise((r) => setTimeout(r, 800));
      rmrf(dataDir);
    }
  }

  // --- Persistence starts and stops its own servers ---
  console.log("\n=== dependency graph persistence ===");
  if (!runTest("depgraph-persist.test.js")) allPassed = false;

  console.log("\n=== persistence ===");
  rmrf(tmp("cacheforge-persist"));
  if (!runTest("persistence.test.js")) allPassed = false;
  rmrf(tmp("cacheforge-persist"));

  // --- Skip list unit tests (TypeScript, run via ts-node) ---
  console.log("\n=== skiplist ===");
  const sl = spawnSync(
    NPX,
    ["ts-node", "--project", "tsconfig.json", "--transpile-only", "tests/skiplist.test.ts"],
    { cwd: BACKEND, stdio: "inherit", shell: process.platform === "win32" }
  );
  if (sl.status !== 0) allPassed = false;

  console.log(allPassed ? "\nAll suites passed." : "\nSome suites FAILED.");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
