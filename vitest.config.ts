/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Standalone test config (kept separate from vite.config.ts so the Tauri build
// pipeline and the test runner don't fight over plugins/options).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules/**", "src-tauri/**", "e2e/**", "dist/**"],
    css: false,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.{test,spec}.{ts,tsx}", "src/test/**", "src/**/*.d.ts"],
    },
  },
});
