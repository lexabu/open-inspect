// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { GitHubIntegrationSettings } from "./github-integration-settings";
import {
  autoReviewControls,
  fetchMock,
  mutateMock,
  okJson,
  repo,
  repoOverrideRow,
  setupSWR,
  stubPointerApis,
  useSWRMock,
} from "./github-integration-settings.test-support";

let search = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({ hasPermission: () => true }),
}));

expect.extend(matchers);

vi.mock("swr", async () => {
  const support = await import("./github-integration-settings.test-support");
  return { default: support.useSWRMock, mutate: support.mutateMock };
});

vi.mock("@/hooks/use-enabled-models", async () => {
  const support = await import("./github-integration-settings.test-support");
  return support.enabledModelsMock;
});

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

beforeAll(stubPointerApis);

beforeEach(() => {
  search = "";
  fetchMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  mutateMock.mockReset();
  useSWRMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GitHubIntegrationSettings", () => {
  it("retains a failed repository addition for retry and clears it after success", async () => {
    const user = userEvent.setup();
    setupSWR({ global: null, availableRepos: [repo("Group/Subgroup/Repository")] });
    fetchMock
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Try again" }) })
      .mockResolvedValueOnce(okJson({}));
    render(<GitHubIntegrationSettings />);

    const picker = screen.getByRole("combobox", { name: "Select a repository" });
    const add = screen.getByRole("button", { name: "Add Override" });
    expect(add).toBeDisabled();
    await user.click(picker);
    await user.click(screen.getByRole("option", { name: "Group/Subgroup/Repository" }));
    await user.click(add);

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Try again"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github/repos/group%2Fsubgroup/repository",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ settings: {} }) })
    );
    expect(picker).toHaveTextContent("Group/Subgroup/Repository");
    expect(add).toBeEnabled();
    expect(mutateMock).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();

    await user.click(add);
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Override added."));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mutateMock).toHaveBeenCalledWith("/api/integration-settings/github/repos");
    expect(picker).toHaveTextContent("Select a repository...");
    expect(add).toBeDisabled();
  });

  it("marks global auto-review deprecated with an accessible team-owned template replacement", () => {
    setupSWR({ global: null });

    render(<GitHubIntegrationSettings />);

    const toggle = screen.getByRole("switch", { name: /auto-review new prs/i });
    const label = toggle.closest("label")!;
    expect(label).toHaveAttribute("for", toggle.id);
    expect(within(label).getByText("Deprecated")).toBeInTheDocument();
    expect(within(label).queryByRole("link")).not.toBeInTheDocument();
    expect(toggle).toHaveAccessibleDescription(/team-owned automation/);
    expect(toggle).toHaveAccessibleDescription(/workspace-owned sessions/);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("link", { name: "Review new PRs" })).toHaveAttribute(
      "href",
      "/automations/new?template=review-new-prs&requireTeam=true"
    );
  });

  it("preserves the current team scope in both replacement links", () => {
    search = "teamId=team_engineering";
    setupSWR({
      global: null,
      repos: [{ repo: "acme/web", settings: {} }],
      availableRepos: [repo("acme/web")],
    });

    render(<GitHubIntegrationSettings />);

    const links = screen.getAllByRole("link", { name: "Review new PRs" });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute(
        "href",
        "/automations/new?template=review-new-prs&teamId=team_engineering&requireTeam=true"
      );
    }
  });

  it.each([undefined, false, true])(
    "shows the deprecation notice and template for repo auto-review=%s without changing controls",
    (autoReviewOnOpen) => {
      setupSWR({
        global: { defaults: { autoReviewOnOpen: true } },
        repos: [{ repo: "acme/web", settings: { autoReviewOnOpen } }],
        availableRepos: [repo("acme/web")],
      });

      render(<GitHubIntegrationSettings />);

      const controls = autoReviewControls(repoOverrideRow("acme/web"));
      expect(within(controls).getByText("Deprecated")).toBeInTheDocument();
      expect(within(controls).getByRole("link", { name: "Review new PRs" })).toHaveAttribute(
        "href",
        "/automations/new?template=review-new-prs&requireTeam=true"
      );
      expect(within(controls).getByRole("combobox")).toHaveAccessibleDescription(
        /team-owned automation/
      );
      if (autoReviewOnOpen === undefined) {
        expect(within(controls).queryByRole("switch")).not.toBeInTheDocument();
        expect(within(controls).getByRole("combobox")).toHaveTextContent("Use global default");
      } else {
        const toggle = within(controls).getByRole("switch", {
          name: autoReviewOnOpen ? "Enabled" : "Disabled",
        });
        expect(toggle.closest("label")).not.toBeNull();
        expect(toggle).toHaveAttribute("aria-checked", String(autoReviewOnOpen));
        expect(toggle).toHaveAccessibleDescription(/workspace-owned sessions/);
      }
    }
  );

  it("starts integration content at heading level two", () => {
    setupSWR({ global: null });

    render(<GitHubIntegrationSettings />);

    expect(screen.getByRole("heading", { name: "GitHub Bot", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connection", level: 3 })).toBeInTheDocument();
  });

  it("saves the selected repository allowlist", async () => {
    const user = userEvent.setup();
    setupSWR({ global: null, availableRepos: [repo("Group/Subgroup/Repository")] });
    fetchMock.mockResolvedValue(okJson({}));

    render(<GitHubIntegrationSettings />);

    await user.click(screen.getByRole("radio", { name: /Selected repositories/ }));
    await user.click(screen.getByRole("checkbox", { name: "Group/Subgroup/Repository" }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: { autoReviewOnOpen: true },
            enabledRepos: ["group/subgroup/repository"],
          },
        }),
      })
    );
  });

  it("renders the default-off Autofix block and persists one complete global policy", async () => {
    const user = userEvent.setup();
    setupSWR({ global: { defaults: { autoReviewOnOpen: true } } });
    fetchMock.mockResolvedValue(okJson({}));

    render(<GitHubIntegrationSettings />);

    expect(screen.getByRole("switch", { name: "Enable Autofix" })).toHaveAttribute(
      "aria-checked",
      "false"
    );
    expect(screen.getByRole("switch", { name: "Submitted reviews" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(
      screen.getByText(/reviews from the configured Open Inspect App, regardless of workflow/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Enable Autofix" }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: {
              autoReviewOnOpen: true,
              autofix: {
                enabled: true,
                reviewsEnabled: true,
                prCommentsEnabled: true,
                openInspectReviewsEnabled: true,
                allowedReviewBots: [],
                maxAttemptsPerPrPer24Hours: 30,
              },
            },
          },
        }),
      })
    );
  });

  it("accepts more than one exact review-bot username", async () => {
    const user = userEvent.setup();
    setupSWR({ global: { defaults: { autoReviewOnOpen: true } } });
    fetchMock.mockResolvedValue(okJson({}));

    render(<GitHubIntegrationSettings />);

    const input = screen.getByRole("textbox", { name: "Exact third-party review bots" });
    fireEvent.change(input, { target: { value: "coderabbitai[bot], renovate[bot]" } });
    expect(input).toHaveValue("coderabbitai[bot], renovate[bot]");
    expect(screen.getByText(/bot-authored feedback is untrusted input/i)).toBeInTheDocument();

    const attemptLimit = screen.getByRole("spinbutton", {
      name: "Attempts per PR per 24 hours",
    });
    await user.clear(attemptLimit);
    expect(attemptLimit).toHaveValue(null);
    await user.type(attemptLimit, "75");
    expect(attemptLimit).toHaveValue(75);
    expect(
      screen.getByText(/higher or unlimited attempts increase autonomous work/i)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github",
      expect.objectContaining({
        body: expect.stringContaining(
          '"allowedReviewBots":["coderabbitai[bot]","renovate[bot]"],"maxAttemptsPerPrPer24Hours":75'
        ),
      })
    );
  });

  it("persists an explicit unlimited Autofix attempt policy", async () => {
    const user = userEvent.setup();
    setupSWR({ global: { defaults: { autoReviewOnOpen: true } } });
    fetchMock.mockResolvedValue(okJson({}));

    render(<GitHubIntegrationSettings />);

    await user.click(screen.getByRole("checkbox", { name: "No Autofix attempt limit" }));
    expect(screen.getByRole("spinbutton", { name: "Attempts per PR per 24 hours" })).toBeDisabled();
    expect(screen.getByText(/unlimited attempts increase autonomous work/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integration-settings/github",
      expect.objectContaining({
        body: expect.stringContaining('"maxAttemptsPerPrPer24Hours":null'),
      })
    );
  });
});
