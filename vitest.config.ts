import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "rcmdsh-core": path.resolve(process.cwd(), "packages/shared/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
