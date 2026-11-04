// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "eval/**", ".claude/**", "public/**"] },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // Logs must never print env, prompts or raw stderr (design §9): log through a redacting helper.
      "no-console": "error",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
);
