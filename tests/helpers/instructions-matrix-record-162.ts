// Records tests/fixtures/instructions-matrix-162.json from the instructions code in this checkout. Run ONCE, on the code
// before the `instructions` field:  npx tsx tests/helpers/instructions-matrix-record-162.ts > tests/fixtures/instructions-matrix-162.json
import { createHash } from "node:crypto";
import { buildFleetInstructions, buildNativeFleetInstructions } from "../../src/instructions.js";
import { matrixCases } from "./instructions-matrix-162.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const golden: Record<string, string> = {};
for (const { key, params } of matrixCases()) {
  golden[`fleet|${key}`] = sha(buildFleetInstructions(params));
  golden[`native|${key}`] = sha(buildNativeFleetInstructions(params, false));
  golden[`native-general|${key}`] = sha(buildNativeFleetInstructions(params, true));
}
process.stdout.write(JSON.stringify(golden, null, 0) + "\n");
