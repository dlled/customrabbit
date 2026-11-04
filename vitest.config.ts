import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Tests are offline; never inherit real credentials from the developer's shell.
    env: {
      MYRABBIT_GITHUB_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CODEX_AUTH_JSON: "",
      GITHUB_TOKEN: "",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      OPENAI_API_KEY: "",
      CODEX_API_KEY: "",
    },
    restoreMocks: true,
    unstubEnvs: true,
  },
});
