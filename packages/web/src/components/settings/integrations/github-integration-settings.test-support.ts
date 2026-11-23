import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import type {
  GitHubBotSettings,
  GitHubGlobalConfig,
} from "@open-inspect/shared/types/integrations";

/** Shared by the GitHub settings test files; each file still declares its own vi.mock calls. */
export const useSWRMock = vi.fn();
export const mutateMock = vi.fn();
export const fetchMock = vi.fn();

export const enabledModelsMock = {
  useEnabledModels: () => ({
    enabledModelOptions: [
      {
        category: "Anthropic",
        models: [{ id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
      },
      {
        category: "OpenAI",
        models: [
          { id: "openai/gpt-5.4", name: "GPT 5.4" },
          { id: "openai/gpt-5.6-sol", name: "GPT 5.6 Sol" },
        ],
      },
    ],
  }),
};

interface RepoSettingsEntry {
  repo: string;
  settings: GitHubBotSettings;
}

export function setupSWR(opts: {
  global?: GitHubGlobalConfig | null;
  repos?: RepoSettingsEntry[];
  availableRepos?: EnrichedRepository[];
  globalLoading?: boolean;
  reposLoading?: boolean;
}) {
  useSWRMock.mockImplementation((key: string) => {
    if (key === "/api/integration-settings/github") {
      return {
        data: opts.global === undefined ? undefined : { settings: opts.global },
        isLoading: opts.globalLoading ?? false,
      };
    }
    if (key === "/api/integration-settings/github/repos") {
      return {
        data: { repos: opts.repos ?? [] },
        isLoading: opts.reposLoading ?? false,
      };
    }
    if (key === "/api/repos") {
      return {
        data: { repos: opts.availableRepos ?? [] },
        isLoading: false,
      };
    }
    return { data: undefined, isLoading: false };
  });
}

export function repo(fullName: string): EnrichedRepository {
  return {
    fullName,
    private: false,
    description: null,
    htmlUrl: `https://github.com/${fullName}`,
    defaultBranch: "main",
  } as unknown as EnrichedRepository;
}

export function okJson(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

export function repoOverrideRow(fullName: string) {
  return screen.getByText(fullName).closest("div")!.parentElement!;
}

export function autoReviewControls(row: HTMLElement) {
  return within(row).getByText("Auto-review new PRs").parentElement!;
}

export async function selectAutoReviewMode(row: HTMLElement, option: RegExp) {
  const user = userEvent.setup();
  await user.click(within(autoReviewControls(row)).getByRole("combobox"));
  await user.click(await screen.findByRole("option", { name: option }));
}

/** Pointer and scroll stubs Radix needs under jsdom. */
export function stubPointerApis() {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}
