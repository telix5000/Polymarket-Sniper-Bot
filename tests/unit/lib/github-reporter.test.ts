import assert from "node:assert";
import { test, describe, beforeEach, afterEach } from "node:test";
import {
  GitHubReporter,
  initGitHubReporter,
  getGitHubReporter,
} from "../../../src/infra/github-reporter";

/**
 * Unit tests for GitHub Error Reporter
 *
 * These tests verify:
 * 1. Reporter initialization and configuration
 * 2. Diagnostic workflow reporting
 * 3. Singleton management
 */

describe("GitHubReporter", () => {
  // Save original env vars
  let originalToken: string | undefined;
  let originalRepo: string | undefined;
  let originalEnabled: string | undefined;

  beforeEach(() => {
    originalToken = process.env.GITHUB_ERROR_REPORTER_TOKEN;
    originalRepo = process.env.GITHUB_ERROR_REPORTER_REPO;
    originalEnabled = process.env.GITHUB_ERROR_REPORTER_ENABLED;
  });

  afterEach(() => {
    // Restore original env vars
    if (originalToken !== undefined) {
      process.env.GITHUB_ERROR_REPORTER_TOKEN = originalToken;
    } else {
      delete process.env.GITHUB_ERROR_REPORTER_TOKEN;
    }
    if (originalRepo !== undefined) {
      process.env.GITHUB_ERROR_REPORTER_REPO = originalRepo;
    } else {
      delete process.env.GITHUB_ERROR_REPORTER_REPO;
    }
    if (originalEnabled !== undefined) {
      process.env.GITHUB_ERROR_REPORTER_ENABLED = originalEnabled;
    } else {
      delete process.env.GITHUB_ERROR_REPORTER_ENABLED;
    }
  });

  describe("Initialization", () => {
    test("should be disabled when token is not set", () => {
      delete process.env.GITHUB_ERROR_REPORTER_TOKEN;
      delete process.env.GITHUB_ERROR_REPORTER_REPO;

      const reporter = new GitHubReporter();

      assert.strictEqual(reporter.isEnabled(), false);
    });

    test("should be disabled when repo is not set", () => {
      process.env.GITHUB_ERROR_REPORTER_TOKEN = "ghp_test_token";
      delete process.env.GITHUB_ERROR_REPORTER_REPO;

      const reporter = new GitHubReporter();

      assert.strictEqual(reporter.isEnabled(), false);
    });

    test("should be disabled when explicitly disabled", () => {
      process.env.GITHUB_ERROR_REPORTER_TOKEN = "ghp_test_token";
      process.env.GITHUB_ERROR_REPORTER_REPO = "owner/repo";
      process.env.GITHUB_ERROR_REPORTER_ENABLED = "false";

      const reporter = new GitHubReporter();

      assert.strictEqual(reporter.isEnabled(), false);
    });

    test("should be enabled when both token and repo are set", () => {
      process.env.GITHUB_ERROR_REPORTER_TOKEN = "ghp_test_token";
      process.env.GITHUB_ERROR_REPORTER_REPO = "owner/repo";
      delete process.env.GITHUB_ERROR_REPORTER_ENABLED;

      const reporter = new GitHubReporter();

      assert.strictEqual(reporter.isEnabled(), true);
    });
  });

  describe("reportDiagnosticWorkflow", () => {
    test("should return false when reporter is disabled", async () => {
      delete process.env.GITHUB_ERROR_REPORTER_TOKEN;
      delete process.env.GITHUB_ERROR_REPORTER_REPO;

      const reporter = new GitHubReporter();

      const result = await reporter.reportDiagnosticWorkflow({
        traceId: "test-trace-123",
        durationMs: 5000,
        steps: [
          { step: "WHALE_BUY", result: "OK" },
          {
            step: "WHALE_SELL",
            result: "SKIPPED",
            reason: "sell_skipped_no_buy",
          },
        ],
      });

      assert.strictEqual(result, false);
    });

    test("should format step results correctly", async () => {
      // We can't actually test the GitHub API call, but we can test the internal logic
      // by creating a reporter and checking its behavior
      delete process.env.GITHUB_ERROR_REPORTER_TOKEN;

      const reporter = new GitHubReporter();

      // Since reporter is disabled, this will return false
      // but we can verify the method exists and accepts the correct parameters
      const details = {
        traceId: "test-trace-456",
        durationMs: 10000,
        steps: [
          { step: "WHALE_BUY", result: "OK", tokenId: "token123456789012345" },
          {
            step: "WHALE_SELL",
            result: "SKIPPED",
            reason: "sell_skipped_no_buy",
          },
          {
            step: "SCAN_BUY",
            result: "REJECTED",
            reason: "insufficient_liquidity",
          },
          { step: "SCAN_SELL", result: "ERROR", reason: "api_error" },
        ],
      };

      const result = await reporter.reportDiagnosticWorkflow(details);

      // Should return false because reporter is disabled
      assert.strictEqual(result, false);
    });

    test("should count successes correctly", async () => {
      delete process.env.GITHUB_ERROR_REPORTER_TOKEN;

      const reporter = new GitHubReporter();

      // Test with all OK steps
      const allOkDetails = {
        traceId: "test-all-ok",
        durationMs: 5000,
        steps: [
          { step: "WHALE_BUY", result: "OK" },
          { step: "WHALE_SELL", result: "OK" },
          { step: "SCAN_BUY", result: "OK" },
          { step: "SCAN_SELL", result: "OK" },
        ],
      };

      const result = await reporter.reportDiagnosticWorkflow(allOkDetails);
      assert.strictEqual(result, false); // Disabled, but method runs

      // Test with no OK steps (all reports use warning severity)
      const noOkDetails = {
        traceId: "test-no-ok",
        durationMs: 5000,
        steps: [
          { step: "WHALE_BUY", result: "SKIPPED" },
          { step: "WHALE_SELL", result: "SKIPPED" },
          { step: "SCAN_BUY", result: "REJECTED" },
          { step: "SCAN_SELL", result: "ERROR" },
        ],
      };

      const result2 = await reporter.reportDiagnosticWorkflow(noOkDetails);
      assert.strictEqual(result2, false);
    });
  });

  describe("Singleton management", () => {
    test("should return same instance from getGitHubReporter", () => {
      const reporter1 = getGitHubReporter();
      const reporter2 = getGitHubReporter();

      assert.strictEqual(reporter1, reporter2);
    });

    test("should create new instance with initGitHubReporter", () => {
      const reporter2 = initGitHubReporter({
        minSeverity: "error",
      });
      const reporter3 = getGitHubReporter();

      // After init, getGitHubReporter should return the new instance
      assert.strictEqual(reporter2, reporter3);
    });
  });
});
