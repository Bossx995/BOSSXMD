// Railway entrypoint: run the web status server and the WhatsApp bot
// from a Node.js runtime. The Dockerfile guarantees npm/node are available.
require("./server");

const { spawn } = require("child_process");

const bot = spawn(process.execPath, ["index.js"], {
  stdio: "inherit",
  env: process.env
});

bot.on("error", (err) => {
  console.error("❌ Failed to start BOSS-X bot:", err);
  process.exit(1);
});

bot.on("exit", (code, signal) => {
  if (signal) {
    console.error(`❌ BOSS-X bot stopped by signal ${signal}`);
    process.exit(1);
  }
  if (code !== 0) {
    console.error(`❌ BOSS-X bot exited with code ${code}`);
    process.exit(code || 1);
  }
  process.exit(0);
});

function shutdown(signal) {
  try { bot.kill(signal); } catch {}
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
