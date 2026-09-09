import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ACCEPTANCE_MARKERS, RECALL_HEADER_RE } from "../../src/testing/acceptance-constants.js";

interface ProbeState {
  sawRecall: boolean;
}

export default function registerAcceptanceProbe(pi: ExtensionAPI): void {
  const state: ProbeState = { sawRecall: false };

  pi.on("before_agent_start", async (event) => {
    state.sawRecall = RECALL_HEADER_RE.test(event.systemPrompt);
  });

  function openDb(): DatabaseSync {
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    if (!agentDir) throw new Error("missing PI_CODING_AGENT_DIR");
    return new DatabaseSync(path.join(agentDir, "memory", "pi-memory-hindsight.db"));
  }

  pi.registerCommand("accept-probe", {
    description: "Acceptance probe command",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command === "tools") {
        const names = pi.getAllTools().map((tool) => tool.name).sort().join(",");
        ctx.ui.notify(`${ACCEPTANCE_MARKERS.tools}${names}`, "info");
        return;
      }
      if (command === "commands") {
        const names = pi.getCommands().map((item) => item.name).sort().join(",");
        ctx.ui.notify(`${ACCEPTANCE_MARKERS.commands}${names}`, "info");
        return;
      }
      if (command === "recall") {
        ctx.ui.notify(`${ACCEPTANCE_MARKERS.recall}${state.sawRecall ? "true" : "false"}`, "info");
        return;
      }
      if (command === "candidate-stats") {
        const db = openDb();
        try {
          const count = (db.prepare("SELECT COUNT(*) AS count FROM candidates").get() as { count: number }).count;
          const latest = db.prepare("SELECT id, state FROM candidates ORDER BY created_at DESC LIMIT 1").get() as
            | { id: string; state: string }
            | undefined;
          ctx.ui.notify(
            `${ACCEPTANCE_MARKERS.candidateStats}${count} latest_id=${latest?.id ?? "-"} latest_state=${latest?.state ?? "-"}`,
            "info",
          );
        } finally {
          db.close();
        }
        return;
      }
      if (command === "session-stats") {
        const branch = ctx.sessionManager.getBranch();
        const stateEntries = branch.filter(
          (entry) => entry?.type === "custom" && "customType" in entry && entry.customType === "pi-memory-hindsight:session-state",
        ).length;
        ctx.ui.notify(`${ACCEPTANCE_MARKERS.sessionStats}${stateEntries}`, "info");
        return;
      }
      const branch = ctx.sessionManager.getBranch();
      const customTypes = branch
        .filter((entry) => entry?.type === "custom")
        .map((entry) => ("customType" in entry ? String(entry.customType) : ""))
        .filter(Boolean)
        .join(",");
      ctx.ui.notify(`${ACCEPTANCE_MARKERS.entries}${customTypes}`, "info");
    },
  });
}
