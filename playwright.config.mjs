import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://127.0.0.1:8000" },
  webServer: {
    command: "python3 -m http.server 8000 --directory docs",
    url: "http://127.0.0.1:8000",
    reuseExistingServer: true,
  },
});
