import { defineConfig, devices } from '@playwright/test'
import process from 'node:process'

const PORT = Number(process.env.PORT) || 8137

export default defineConfig({
  testDir: 'test',
  reporter: 'list',
  fullyParallel: true,
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node test/serve.mjs',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    env: { PORT: String(PORT) },
    timeout: 30000,
  },
})
