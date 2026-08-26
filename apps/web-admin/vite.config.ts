/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Web admin SPA. Talks to the Go backend (default http://localhost:8090).
// Override the API base with VITE_API_BASE. The dev proxy below forwards
// /v1/* to the backend so the SPA can use same-origin relative URLs in dev.
//
// @ts-expect-error process is a nodejs global
const apiTarget = process.env.VITE_API_BASE || "http://localhost:8090";

// https://vite.dev/config/
export default defineConfig({
  // Served under /admin in production (the marketing site owns "/").
  base: "/admin/",
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Keep the application shell small and cache slow-moving framework,
        // localization and telemetry code independently. This also prevents
        // one monolithic >500 kB entry chunk as the dashboard grows.
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          i18n: ["i18next", "react-i18next", "i18next-browser-languagedetector"],
          sentry: ["@sentry/react"],
        },
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/v1": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    restoreMocks: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
