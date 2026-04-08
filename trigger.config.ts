import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_ID || "reels-intelligence",
  runtime: "node",
  logLevel: "log",
  maxDuration: 600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 5000,
      maxTimeoutInMs: 60000,
      factor: 2,
    },
  },
  dirs: ["./trigger"],
});
