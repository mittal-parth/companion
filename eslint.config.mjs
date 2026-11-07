import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["apps/web/**", "**/node_modules/**", "**/.next/**", "**/dist/**"],
  },
  ...tseslint.configs.recommended,
);
