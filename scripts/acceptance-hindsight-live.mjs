import { writeFile } from "node:fs/promises";
import { runLiveHindsightAcceptance } from "../dist/testing/live-hindsight-acceptance.js";

const EVIDENCE_PATH = "/tmp/pi-memory-hindsight-acceptance-hindsight-live.json";

const evidence = await runLiveHindsightAcceptance(process.env);
await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(`wrote evidence to ${EVIDENCE_PATH}`);
