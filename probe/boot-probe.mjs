// Real-boot probe: load the built companion plugin through
// @deepseek-ai/dsh-app-boot. This does not call a model and does not need an
// API key. A live agent turn is a separate check and is reported as skipped
// when no model endpoint is configured.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const installed = "/tmp/dsh-runtime/node_modules";
const DSH = process.env.DSH_NODE_MODULES ?? (
  existsSync(`${installed}/@deepseek-ai/dsh-app-boot/lib/index.js`)
    ? installed
    : path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@deepseek-ai/dsh/node_modules")
);
const { boot } = await import(`${DSH}/@deepseek-ai/dsh-app-boot/lib/index.js`);
const { provideCmdline } = await import(`${DSH}/@deepseek-ai/dsh-cmdline/lib/index.js`);
const { createLaunchEnvironmentSnapshot } = await import(`${DSH}/@deepseek-ai/dsh-launch-environment/lib/index.js`);

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
mkdirSync(path.join(root, "probe/tmp"), { recursive: true });
const work = mkdtempSync(path.join(root, "probe/tmp/companion-"));
const dbPath = path.join(work, "companion.db");
const configPath = path.join(work, "cordis.yml");
const template = readFileSync(path.join(root, "probe/cordis.yml"), "utf8");
writeFileSync(configPath, template
  .replace("name: ../dist/index.js", `name: ${path.join(root, "dist/index.js")}`)
  .replace("path: probe/tmp/companion.db", `path: ${dbPath}`));

process.stdout.isTTY = true;
const failures = [];
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

let ctx;
try {
  ctx = await boot("companion-probe", configPath, [], (host) => {
    provideCmdline(host, { args: [], exit: (code = 0) => process.exit(code) });
    host.provide(
      "launchEnvironment",
      createLaunchEnvironmentSnapshot([{ source: "process", values: process.env }]),
    );
  });

  const visible = ctx.tools.schemas().map((item) => item.name);
  check("history_search registered", visible.includes("history_search") && ctx.tools.get("history_search") !== undefined);

  const assembly = await ctx.systemPrompt.assemble({});
  const persona = assembly.sections.find((section) => section.name === "companion:persona");
  check("persona section is present", Boolean(persona?.text.includes("同一个人")));
  check("persona section has no transcript", !persona?.text.includes("年糕"));

  const session = { id: "probe-session" };
  ctx.emit("session/event", session, { type: "turn/start", time: 1, data: { turn: 1 } });
  ctx.emit("session/event", session, {
    type: "user/message",
    time: 2,
    data: { role: "user", content: "我养了一只叫年糕的白猫，它怕打雷。", source: { kind: "user" } },
  });
  ctx.emit("session/event", session, {
    type: "assistant/message",
    time: 3,
    data: { turn: 1, message: { role: "assistant", content: "我记住了，年糕怕打雷。" } },
  });

  const searched = await ctx.tools.execute({
    callId: "probe-search",
    name: "history_search",
    arguments: { query: "年糕怕什么", limit: 1, around: 0 },
    agent: { id: "probe-agent", session },
    signal: new AbortController().signal,
  });
  check("hook-fed search is not a tool error", !searched.isError, searched.isError ? searched.error?.message : "");
  check("search recalls the raw turn", !searched.isError && searched.value.snippets.some((item) => item.text.includes("年糕") && item.text.includes("打雷")));

  const decision = await ctx.waterfall("agent/pre-step", {
    agent: { id: "probe-agent", session: { id: "probe-session-2" } },
    messages: [{ role: "user", content: "年糕怕什么", source: { kind: "user" } }],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [{ role: "user", content: "年糕怕什么", source: { kind: "user" } }],
  }));
  const head = decision?.messages?.[0];
  const headText = Array.isArray(head?.content) ? head.content.map((block) => block.text ?? "").join("") : "";
  check("pre-step prepends first-person recall", decision?.kind === "enter" && headText.includes("我记得") && headText.includes("年糕"));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  failures.push("boot");
} finally {
  if (ctx) await ctx.fiber.dispose();
  rmSync(work, { recursive: true, force: true });
}

console.log("SKIP  live model turn — no DeepSeek API key and no custom model endpoint was required for this probe");
console.log(failures.length === 0 ? "\nALL PROBE CHECKS PASSED" : `\n${failures.length} FAILURE(S): ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
