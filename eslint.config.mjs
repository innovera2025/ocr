import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: ["**/node_modules/**", "**/dist/**"]
  },
  {
    files: ["**/*.ts", "**/*.mjs"],
    languageOptions: { parser: tsParser },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "no-console": "error",
      "no-undef": "off"
    }
  },
  {
    files: ["**/*.mjs"],
    rules: { "no-undef": "error" }
  }
];
