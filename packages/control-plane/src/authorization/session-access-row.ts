import type { SessionAccessRow } from "@open-inspect/shared";
import type { SessionEntry } from "../db/session-index";

/** The facts access decisions read from a stored session and its collaborators. */
export function sessionAccessRow(
  session: Pick<SessionEntry, "id" | "userId" | "ownerTeamId" | "visibility" | "platformHeld">,
  collaboratorIds: readonly string[]
): SessionAccessRow {
  return {
    id: session.id,
    ownerUserId: session.userId ?? null,
    ownerTeamId: session.ownerTeamId,
    visibility: session.visibility,
    collaboratorIds,
    platformHeld: session.platformHeld === true,
  };
}
