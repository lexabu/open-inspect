// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { GITHUB_AUTOFIX_DEFAULTS } from "@open-inspect/shared/types/integrations";
import { GitHubIntegrationSettings } from "./github-integration-settings";
import {
  autoReviewControls,
  fetchMock,
  mutateMock,
  okJson,
  repo,
  repoOverrideRow,
  selectAutoReviewMode,
  setupSWR,
  stubPointerApis,
  useSWRMock,
} from "./github-integration-settings.test-support";

// Model, harness and save-path tests for the GitHub settings forms.

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({ hasPermission: () => true }),
}));

vi.mock("swr", async () => {
  const support = await import("./github-integration-settings.test-support");
  return { default: support.useSWRMock, mutate: support.mutateMock };
});

vi.mock("@/hooks/use-enabled-models", async () => {
  const support = await import("./github-integration-settings.test-support");
  return support.enabledModelsMock;
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

expect.extend(matchers);

beforeAll(stubPointerApis);

beforeEach(() => {
  fetchMock.mockReset();
  mutateMock.mockReset();
  useSWRMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GitHubIntegrationSettings models and saves", () => {
  it("renders and preserves global model and reasoning defaults", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: {
        defaults: {
          autoReviewOnOpen: true,
          model: "anthropic/claude-sonnet-4-6",
          reasoningEffort: "high",
          autofix: { enabled: true, reviewsEnabled: false },
        },
      },
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<GitHubIntegrationSettings />);

    expect(screen.getByText("Default model")).toBeInTheDocument();
    expect(screen.getByText("Default reasoning effort")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Default model" })).toHaveTextContent(
      "Claude Sonnet 4.6"
    );
    expect(screen.getByRole("combobox", { name: "Default reasoning effort" })).toHaveTextContent(
      "high"
    );

    await user.click(screen.getByRole("switch", { name: /auto-review new prs/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: {
              autoReviewOnOpen: false,
              model: "anthropic/claude-sonnet-4-6",
              reasoningEffort: "high",
              autofix: {
                ...GITHUB_AUTOFIX_DEFAULTS,
                enabled: true,
                reviewsEnabled: false,
              },
            },
          },
        }),
      })
    );
  });

  it("keeps API-set reviewers when saving unrelated global and repo settings", async () => {
    const user = userEvent.setup();
    const reviewers = [
      { model: "amazon-bedrock/openai.gpt-6.2-sol", harness: "opencode" as const },
      { model: "anthropic/claude-opus-4-5", harness: "claude" as const },
    ];
    setupSWR({
      global: {
        defaults: {
          autoReviewOnOpen: true,
          reviewers,
          commentOnlyReviews: true,
          reviewTip: true,
          mergeGate: "shadow",
        },
      },
      repos: [
        {
          repo: "acme/web",
          settings: {
            reviewers: reviewers.slice(0, 1),
            commentOnlyReviews: false,
            reviewTip: false,
            mergeGate: "required",
          },
        },
      ],
      availableRepos: [repo("acme/web")],
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<GitHubIntegrationSettings />);

    await user.click(screen.getByRole("switch", { name: /auto-review new prs/i }));
    await user.click(screen.getAllByRole("button", { name: /^save$/i })[0]);
    const row = repoOverrideRow("acme/web");
    await selectAutoReviewMode(row, /override for this repo/i);
    await user.click(within(row).getByRole("button", { name: /^save$/i }));

    const bodies = fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
      .map(([url, init]) => [url, JSON.parse(String((init as RequestInit).body)).settings]);
    expect(bodies).toContainEqual([
      "/api/integration-settings/github",
      expect.objectContaining({
        defaults: expect.objectContaining({
          reviewers,
          commentOnlyReviews: true,
          reviewTip: true,
          mergeGate: "shadow",
        }),
      }),
    ]);
    expect(bodies).toContainEqual([
      "/api/integration-settings/github/repos/acme/web",
      expect.objectContaining({
        reviewers: reviewers.slice(0, 1),
        commentOnlyReviews: false,
        reviewTip: false,
        mergeGate: "required",
      }),
    ]);
  });

  it("clears global model defaults without resetting unrelated settings", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: {
        defaults: {
          autoReviewOnOpen: false,
          model: "anthropic/claude-sonnet-4-6",
          reasoningEffort: "high",
          codeReviewInstructions: "Focus on security.",
        },
      },
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<GitHubIntegrationSettings />);

    await user.click(screen.getByRole("combobox", { name: "Default reasoning effort" }));
    await user.click(await screen.findByRole("option", { name: "Use model default" }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/integration-settings/github",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: {
              autoReviewOnOpen: false,
              model: "anthropic/claude-sonnet-4-6",
              codeReviewInstructions: "Focus on security.",
            },
          },
        }),
      })
    );

    await user.click(screen.getByRole("combobox", { name: "Default model" }));
    await user.click(await screen.findByRole("option", { name: "Use system default" }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/integration-settings/github",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: {
              autoReviewOnOpen: false,
              codeReviewInstructions: "Focus on security.",
            },
          },
        }),
      })
    );
  });

  it("preserves sparse Autofix overrides when saving an unrelated repo setting", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: {
        defaults: {
          autoReviewOnOpen: false,
          autofix: { maxAttemptsPerPrPer24Hours: null },
        },
      },
      repos: [{ repo: "acme/web", settings: { autofix: { enabled: true } } }],
      availableRepos: [repo("acme/web")],
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<GitHubIntegrationSettings />);

    const row = repoOverrideRow("acme/web");
    await selectAutoReviewMode(row, /override for this repo/i);

    expect(within(autoReviewControls(row)).getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "false"
    );

    await user.click(within(row).getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github/repos/acme/web",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: {
            autoReviewOnOpen: false,
            autofix: { enabled: true },
          },
        }),
      })
    );
  });

  it.each([false, true])(
    "repo auto-review override value %s renders and persists after mode changes",
    async (autoReviewOnOpen) => {
      const user = userEvent.setup();
      setupSWR({
        global: { defaults: { autoReviewOnOpen: !autoReviewOnOpen } },
        repos: [{ repo: "acme/web", settings: { autoReviewOnOpen } }],
        availableRepos: [repo("acme/web")],
      });
      fetchMock.mockResolvedValue(okJson({}));

      render(<GitHubIntegrationSettings />);

      const row = repoOverrideRow("acme/web");
      expect(
        within(autoReviewControls(row)).getByText(autoReviewOnOpen ? "Enabled" : "Disabled")
      ).toBeInTheDocument();
      expect(within(autoReviewControls(row)).getByRole("switch")).toHaveAttribute(
        "aria-checked",
        String(autoReviewOnOpen)
      );

      await selectAutoReviewMode(row, /use global default/i);
      await selectAutoReviewMode(row, /override for this repo/i);
      await user.click(within(row).getByRole("button", { name: /^save$/i }));

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/integration-settings/github/repos/acme/web",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ settings: { autoReviewOnOpen } }),
        })
      );
    }
  );

  it("requires a compatible default model when switching the global harness to Claude Agent", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: {
        defaults: {
          autoReviewOnOpen: true,
          model: "openai/gpt-5.4",
          reasoningEffort: "high",
        },
      },
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<GitHubIntegrationSettings />);

    await user.click(screen.getByRole("combobox", { name: "Agent harness" }));
    await user.click(await screen.findByRole("option", { name: "Claude Agent" }));
    const model = screen.getByRole("combobox", { name: "Default model" });
    expect(model).toHaveTextContent("Choose a model");
    expect(screen.getByText(/Choose a default model Claude Agent can run/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Default reasoning effort" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(model);
    expect(screen.queryByRole("option", { name: "Use system default" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "GPT 5.4" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "Claude Sonnet 4.6" }));
    expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: {
              autoReviewOnOpen: true,
              model: "anthropic/claude-sonnet-4-6",
              harness: "claude",
            },
          },
        }),
      })
    );
  });

  it("offers Codex reasoning efforts for global defaults", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: {
        defaults: {
          harness: "codex",
          model: "openai/gpt-5.6-sol",
          reasoningEffort: "max",
        },
      },
    });

    render(<GitHubIntegrationSettings />);

    const reasoning = screen.getByRole("combobox", { name: "Default reasoning effort" });
    expect(reasoning).toHaveTextContent("max");
    await user.click(reasoning);
    expect(screen.getByRole("option", { name: "max" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "none" })).not.toBeInTheDocument();
  });

  it.each([undefined, "anthropic/claude-sonnet-4-6", "openai/gpt-5.4"])(
    "requires a repo model with an explicit Claude harness despite global model=%s",
    async (inheritedModel) => {
      const user = userEvent.setup();
      setupSWR({
        global: { defaults: { autoReviewOnOpen: true, model: inheritedModel } },
        repos: [{ repo: "acme/web", settings: {} }],
        availableRepos: [repo("acme/web")],
      });
      fetchMock.mockResolvedValue(okJson({}));

      render(<GitHubIntegrationSettings />);

      const row = repoOverrideRow("acme/web");
      await user.click(within(row).getByRole("combobox", { name: "Agent harness" }));
      await user.click(await screen.findByRole("option", { name: "Claude Agent" }));
      const model = within(row).getByRole("combobox", { name: "Model" });
      expect(model).toHaveTextContent("Choose a model");
      expect(within(row).getByText(/requires a model at the same level/)).toBeInTheDocument();
      expect(within(row).getByRole("button", { name: /^save$/i })).toBeDisabled();
      await user.click(within(row).getByRole("button", { name: /^save$/i }));
      expect(fetchMock).not.toHaveBeenCalled();

      await user.click(model);
      expect(screen.queryByRole("option", { name: "Use global model" })).not.toBeInTheDocument();
      expect(screen.queryByRole("option", { name: "GPT 5.4" })).not.toBeInTheDocument();
      await user.click(await screen.findByRole("option", { name: "Claude Sonnet 4.6" }));
      await user.click(within(row).getByRole("button", { name: /^save$/i }));

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/integration-settings/github/repos/acme/web",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            settings: { model: "anthropic/claude-sonnet-4-6", harness: "claude" },
          }),
        })
      );
    }
  );

  it("returns repo harness and model overrides to the global Claude defaults", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: {
        defaults: {
          autoReviewOnOpen: true,
          harness: "claude",
          model: "anthropic/claude-sonnet-4-6",
        },
      },
      repos: [
        {
          repo: "acme/web",
          settings: {
            harness: "claude",
            model: "anthropic/claude-sonnet-4-6",
            reasoningEffort: "high",
          },
        },
      ],
      availableRepos: [repo("acme/web")],
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<GitHubIntegrationSettings />);

    const row = repoOverrideRow("acme/web");
    // The single harness selector holds the override; inheriting clears it.
    expect(within(row).getByRole("combobox", { name: "Agent harness" })).toHaveTextContent(
      "Claude Agent"
    );
    await user.click(within(row).getByRole("combobox", { name: "Agent harness" }));
    await user.click(await screen.findByRole("option", { name: "Use global harness" }));
    await user.click(within(row).getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: "Use global model" }));
    await user.click(within(row).getByRole("button", { name: /^save$/i }));

    // Sparse save: no harness key means the repo inherits the global one.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github/repos/acme/web",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ settings: {} }),
      })
    );
  }, 20000);

  it("filters the repo model picker by the inherited global harness", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: {
        defaults: {
          autoReviewOnOpen: true,
          harness: "claude",
          model: "anthropic/claude-sonnet-4-6",
        },
      },
      repos: [{ repo: "acme/web", settings: {} }],
      availableRepos: [repo("acme/web")],
    });
    fetchMock.mockResolvedValue(okJson({}));

    render(<GitHubIntegrationSettings />);

    const row = repoOverrideRow("acme/web");
    await user.click(within(row).getByRole("combobox", { name: "Model" }));
    await screen.findByRole("option", { name: "Claude Sonnet 4.6" });
    expect(screen.getByRole("option", { name: "Use global model" })).toBeInTheDocument();
    // Global harness is Claude Agent: GPT models are not offered for this repo.
    expect(screen.queryByRole("option", { name: "GPT 5.4" })).toBeNull();
  }, 20000);

  it.each([
    { globalModel: "anthropic/claude-sonnet-4-6", repoModel: undefined, warns: false },
    { globalModel: undefined, repoModel: undefined, warns: false },
    { globalModel: "openai/gpt-5", repoModel: undefined, warns: false },
    { globalModel: "openai/gpt-5.4", repoModel: undefined, warns: true },
    { globalModel: "anthropic/claude-sonnet-4-6", repoModel: "openai/gpt-5.4", warns: true },
  ])("warns without blocking sparse saves: %j", async (selection) => {
    const user = userEvent.setup();
    setupSWR({
      global: { defaults: { harness: "claude", model: selection.globalModel } },
      repos: [{ repo: "acme/web", settings: { model: selection.repoModel } }],
      availableRepos: [repo("acme/web")],
    });
    fetchMock.mockResolvedValue(okJson({}));
    render(<GitHubIntegrationSettings />);
    const row = repoOverrideRow("acme/web");
    expect(within(row).queryByText(/requires a model at the same level/)).not.toBeInTheDocument();
    expect(within(row).queryByText(/fall back|deployment default/)).not.toBeInTheDocument();
    const warning = within(row).queryByText(/Sessions using this default model will be refused/);
    if (selection.warns) {
      expect(warning).toHaveTextContent("cannot run on the Claude Agent harness");
    } else {
      expect(warning).not.toBeInTheDocument();
    }
    await selectAutoReviewMode(row, /override for this repo/i);
    expect(within(row).getByRole("button", { name: /^save$/i })).toBeEnabled();
    await user.click(within(row).getByRole("button", { name: /^save$/i }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github/repos/acme/web",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: { model: selection.repoModel, autoReviewOnOpen: true },
        }),
      })
    );
  });

  it("updates the non-blocking warning when the global harness changes", async () => {
    setupSWR({
      global: { defaults: { model: "anthropic/claude-sonnet-4-6" } },
      repos: [{ repo: "acme/web", settings: { model: "openai/gpt-5.4" } }],
    });
    const { rerender } = render(<GitHubIntegrationSettings />);
    expect(screen.queryByText(/Sessions using this default model will be refused/)).toBeNull();

    setupSWR({
      global: { defaults: { harness: "claude", model: "anthropic/claude-sonnet-4-6" } },
      repos: [{ repo: "acme/web", settings: { model: "openai/gpt-5.4" } }],
    });
    rerender(<GitHubIntegrationSettings />);
    const row = repoOverrideRow("acme/web");
    expect(
      within(row).getByText(/Sessions using this default model will be refused/)
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(row).getByRole("combobox", { name: "Agent harness" }));
    await user.click(await screen.findByRole("option", { name: "OpenCode" }));
    expect(within(row).queryByText(/Sessions using this default model will be refused/)).toBeNull();
    expect(within(row).getByRole("button", { name: /^save$/i })).toBeEnabled();
  });

  it("keeps a sparse effort visible when the inherited harness makes it incompatible", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: { defaults: { model: "openai/gpt-5.6-sol" } },
      repos: [
        {
          repo: "acme/web",
          settings: { model: "openai/gpt-5.6-sol", reasoningEffort: "none" },
        },
      ],
      availableRepos: [repo("acme/web")],
    });
    fetchMock.mockResolvedValue(okJson({}));
    const view = render(<GitHubIntegrationSettings />);
    const row = repoOverrideRow("acme/web");
    const reasoning = within(row).getByRole("combobox", { name: "Reasoning effort" });
    expect(reasoning).toHaveTextContent("none");
    expect(within(row).queryByText(/Sessions using this default model will be refused/)).toBeNull();

    setupSWR({
      global: { defaults: { harness: "codex", model: "openai/gpt-5.6-sol" } },
      repos: [
        {
          repo: "acme/web",
          settings: { model: "openai/gpt-5.6-sol", reasoningEffort: "none" },
        },
      ],
      availableRepos: [repo("acme/web")],
    });
    view.rerender(<GitHubIntegrationSettings />);

    expect(reasoning).toHaveTextContent("none");
    expect(
      within(row).getByText(/Sessions using this default model will be refused/)
    ).toHaveTextContent(
      'Reasoning effort "none" cannot run on openai/gpt-5.6-sol with the Codex harness.'
    );

    await selectAutoReviewMode(row, /override for this repo/i);
    await user.click(within(row).getByRole("button", { name: /^save$/i }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github/repos/acme/web",
      expect.objectContaining({
        body: JSON.stringify({
          settings: {
            model: "openai/gpt-5.6-sol",
            reasoningEffort: "none",
            autoReviewOnOpen: true,
          },
        }),
      })
    );
  });

  it("clears incompatible model and effort when inheriting the global Claude harness", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: { defaults: { harness: "claude", model: "anthropic/claude-sonnet-4-6" } },
      repos: [
        {
          repo: "acme/web",
          settings: { harness: "opencode", model: "openai/gpt-5.4", reasoningEffort: "high" },
        },
      ],
      availableRepos: [repo("acme/web")],
    });
    fetchMock.mockResolvedValue(okJson({}));
    render(<GitHubIntegrationSettings />);
    const row = repoOverrideRow("acme/web");
    await user.click(within(row).getByRole("combobox", { name: "Agent harness" }));
    await user.click(await screen.findByRole("option", { name: "Use global harness" }));
    await user.click(within(row).getByRole("button", { name: /^save$/i }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github/repos/acme/web",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ settings: {} }) })
    );
    expect(
      within(row).queryByText(/cannot run on the Claude Agent harness/)
    ).not.toBeInTheDocument();
  });

  it("requires a model for saved global Claude settings without imposing it on an inherited repo", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: { defaults: { harness: "claude" } },
      repos: [{ repo: "acme/web", settings: {} }],
      availableRepos: [repo("acme/web")],
    });
    render(<GitHubIntegrationSettings />);
    expect(screen.getAllByText(/Choose a default model Claude Agent can run/)).toHaveLength(1);
    expect(screen.getByRole("combobox", { name: "Default model" })).toHaveTextContent(
      "Choose a model"
    );
    await user.click(screen.getByRole("switch", { name: /auto-review new prs/i }));
    expect(screen.getAllByRole("button", { name: /^save$/i })[0]).toBeDisabled();
    expect(screen.queryByText(/deployment default|fall back|Sessions will run on/)).toBeNull();
  });

  it.each([undefined, "openai/gpt-5.4", "anthropic/unknown-model"])(
    "blocks a missing, incompatible, or impossible stored explicit model at both levels: %s",
    async (model) => {
      const user = userEvent.setup();
      setupSWR({
        global: { defaults: { harness: "claude", model } },
        repos: [{ repo: "acme/web", settings: { harness: "claude", model } }],
        availableRepos: [repo("acme/web")],
      });
      render(<GitHubIntegrationSettings />);
      await user.click(screen.getByRole("switch", { name: /auto-review new prs/i }));
      const row = repoOverrideRow("acme/web");
      await selectAutoReviewMode(row, /override for this repo/i);
      for (const save of screen.getAllByRole("button", { name: /^save$/i })) {
        expect(save).toBeDisabled();
        await user.click(save);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("keeps global system defaults and repo model inheritance available for OpenCode", async () => {
    const user = userEvent.setup();
    setupSWR({
      global: { defaults: { harness: "claude", model: "anthropic/claude-sonnet-4-6" } },
      repos: [{ repo: "acme/web", settings: { harness: "opencode" } }],
      availableRepos: [repo("acme/web")],
    });
    fetchMock.mockResolvedValue(okJson({}));
    render(<GitHubIntegrationSettings />);
    await user.click(screen.getAllByRole("combobox", { name: "Agent harness" })[0]);
    await user.click(await screen.findByRole("option", { name: "OpenCode" }));
    await user.click(screen.getByRole("combobox", { name: "Default model" }));
    await user.click(await screen.findByRole("option", { name: "Use system default" }));
    await user.click(screen.getAllByRole("button", { name: /^save$/i })[0]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github",
      expect.objectContaining({
        body: JSON.stringify({ settings: { defaults: { autoReviewOnOpen: true } } }),
      })
    );

    const row = repoOverrideRow("acme/web");
    await user.click(within(row).getByRole("combobox", { name: "Model" }));
    expect(screen.getByRole("option", { name: "GPT 5.4" })).toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "Use global model" }));
    await selectAutoReviewMode(row, /override for this repo/i);
    await user.click(within(row).getByRole("button", { name: /^save$/i }));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/integration-settings/github/repos/acme/web",
      expect.objectContaining({
        body: JSON.stringify({ settings: { harness: "opencode", autoReviewOnOpen: true } }),
      })
    );
  });
});
