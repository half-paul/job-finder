import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    settings: { next: { rootDir: "apps/web/" } },
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
  globalIgnores([
    "**/.next/**",
    "**/next-env.d.ts",
    "**/drizzle/meta/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);
