/* Playwright config — browser tests for the things only a browser can prove.
   The Node suites (npm test) cover the rules and the sync contract; these cover
   what a clinician actually sees on screen.

   Run:  npm run e2e            (headless)
         npm run e2e:headed     (watch it drive the app)
         npx playwright show-report

   The server is started fresh against a throwaway data dir on every run, so
   tests always begin from the seeded demo state and never touch ./data. */

const { defineConfig, devices } = require("@playwright/test");

const PORT = Number(process.env.E2E_PORT || 8123);
const DATA = "/tmp/therachart-e2e";

module.exports = defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 7_000 },

  // The store is a single row with one writer (see db.js), so parallel workers
  // would just 409 against each other. These tests are fast; keep them serial.
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",   // full click-by-click replay when something breaks
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    /* THERACHART_DEMO_LOGINS=1 because the seeded demo accounts hold no
       password (store.stripDemoCredentials runs on every boot), and /api/login
       refuses them outright on a server that offers the picker. The picker IS
       the door now — so the tests have to come in through it, the same way a
       demo visitor does. */
    command: `rm -rf ${DATA} && mkdir -p ${DATA} && THERACHART_DATA=${DATA} PORT=${PORT} THERACHART_DEMO_LOGINS=1 GEMINI_API_KEY= GCP_PROJECT= node server.js`,
    url: `http://127.0.0.1:${PORT}/api/ping`,
    reuseExistingServer: false,  // always a clean, seeded database
    timeout: 30_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
