import { runSessionSimulation } from "../dist/index.js";

const result = runSessionSimulation();
if (!result.recalled) {
  console.error("companion session simulation failed");
  process.exit(1);
}
console.log("companion session simulation recalled across sessions");
