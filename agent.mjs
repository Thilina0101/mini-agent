#!/usr/bin/env node
/**
 * mini-agent — a small terminal AI coding agent powered by Claude.
 *
 *   node agent.mjs [project-folder]
 *
 * Claude can list, read and search files on its own. Writing/editing files and
 * running commands always ask for your approval first.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

/* ---------------------------------------------------------------- config */
const HERE = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(HERE, ".env")); } catch { /* no .env file is fine */ }

const MODEL = process.env.AGENT_MODEL || "claude-opus-5-5";
const EFFORT = process.env.AGENT_EFFORT || "high";            // low | medium | high | xhigh | max
const ROOT = path.resolve(process.argv[2] || process.cwd());
const MAX_TOOL_OUTPUT = 20_000;                                // characters returned to Claude per tool call
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv", ".cache"]);
// Server-side refusal fallback (re-runs a declined request on another model). Only these models accept "default".
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
// Approximate Claude Opus 5.5 prices, $ per million tokens (for the running cost estimate only)
const PRICE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

if (!fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  console.error(`Project folder not found: ${ROOT}`);
  process.exit(1);
}
const REAL_ROOT = fs.realpathSync(ROOT);

/* ---------------------------------------------------------------- terminal helpers */
const c = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const dim = c(2), red = c(31), green = c(32), yellow = c(33), cyan = c(36), bold = c(1);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const truncate = (s, n = MAX_TOOL_OUTPUT) =>
  s.length <= n ? s : s.slice(0, n) + `\n… [truncated ${s.length - n} more characters]`;
const rel = (p) => path.relative(ROOT, p) || ".";

/* ---------------------------------------------------------------- safety: keep paths inside the project */
function resolveSafe(p = ".") {
  const target = path.resolve(ROOT, p);
  const r = path.relative(ROOT, target);
  if (r === ".." || r.startsWith(".." + path.sep) || path.isAbsolute(r)) {
    throw new Error(`Path "${p}" is outside the project folder. Only paths inside ${ROOT} are allowed.`);
  }
  // Follow symlinks for paths that exist, so a link can't point outside the project.
  let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const real = fs.realpathSync(existing);
  const rr = path.relative(REAL_ROOT, real);
  if (rr === ".." || rr.startsWith(".." + path.sep) || path.isAbsolute(rr)) {
    throw new Error(`Path "${p}" resolves outside the project folder.`);
  }
  return target;
}

/* ---------------------------------------------------------------- approval */
const alwaysAllow = new Set();
async function approve(kind, preview) {
  console.log(preview);
  if (alwaysAllow.has(kind)) { console.log(dim(`  (auto-approved: ${kind})`)); return { ok: true }; }
  const a = (await rl.question(yellow(`  Allow? [y]es / [n]o / [a]lways allow ${kind} this session / or type feedback: `))).trim();
  const l = a.toLowerCase();
  if (l === "a" || l === "always") { alwaysAllow.add(kind); return { ok: true }; }
  if (l === "y" || l === "yes" || l === "") return { ok: true };
  if (l === "n" || l === "no") return { ok: false, feedback: "" };
  return { ok: false, feedback: a };
}
const declined = (fb) =>
  "The user declined this action." + (fb ? ` Their feedback: ${fb}` : " Ask them how they want to proceed instead of retrying the same action.");

/* ---------------------------------------------------------------- file helpers */
function* walk(dir, depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield { full, dir: true, depth };
      yield* walk(full, depth + 1);
    } else if (e.isFile()) {
      yield { full, dir: false, depth };
    }
  }
}
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

function showDiff(oldStr, newStr) {
  const lines = (s, sign, color) => s.split("\n").slice(0, 30).map((l) => color(`  ${sign} ${l}`)).join("\n")
    + (s.split("\n").length > 30 ? dim(`\n  … ${s.split("\n").length - 30} more lines`) : "");
  return lines(oldStr, "-", red) + "\n" + lines(newStr, "+", green);
}

/* ---------------------------------------------------------------- tools */
const shellName = process.platform === "win32" ? "Windows PowerShell" : "bash";

const TOOLS = [
  {
    name: "list_files",
    description: "List files and folders in the project (recursive, up to 500 entries). Skips node_modules, .git and build folders.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Folder relative to the project root. Default: \".\"" } },
    },
    schema: z.object({ path: z.string().optional() }),
    async run({ path: p }) {
      const dir = resolveSafe(p);
      const out = [];
      for (const e of walk(dir)) {
        out.push(rel(e.full).replaceAll("\\", "/") + (e.dir ? "/" : ""));
        if (out.length >= 500) { out.push("… (stopped at 500 entries; list a subfolder for more)"); break; }
      }
      console.log(dim(`  listed ${rel(dir)} (${out.length} entries)`));
      return out.join("\n") || "(empty folder)";
    },
  },
  {
    name: "read_file",
    description: "Read a text file. Returns numbered lines. For big files, use offset/limit to read part of it.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root" },
        offset: { type: "integer", description: "First line to read (1-based). Default 1" },
        limit: { type: "integer", description: "Number of lines to read. Default 2000" },
      },
      required: ["path"],
    },
    schema: z.object({ path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).optional() }),
    async run({ path: p, offset = 1, limit = 2000 }) {
      const file = resolveSafe(p);
      const buf = fs.readFileSync(file);
      if (isBinary(buf)) return `${p} is a binary file (${buf.length} bytes); it can't be shown as text.`;
      const all = buf.toString("utf8").split(/\r?\n/);
      const part = all.slice(offset - 1, offset - 1 + limit);
      console.log(dim(`  read ${rel(file)} (lines ${offset}-${offset + part.length - 1} of ${all.length})`));
      const body = part.map((l, i) => `${String(offset + i).padStart(5)}\t${l}`).join("\n");
      const more = offset - 1 + limit < all.length ? `\n… (${all.length - (offset - 1 + limit)} more lines; use offset to read on)` : "";
      return truncate(body + more);
    },
  },
  {
    name: "search",
    description: "Search file contents with a regular expression (JavaScript syntax). Returns matches as path:line: text (max 200).",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for" },
        path: { type: "string", description: "Folder (or file) to search in, relative to the project root. Default: \".\"" },
        case_insensitive: { type: "boolean" },
      },
      required: ["pattern"],
    },
    schema: z.object({ pattern: z.string().min(1), path: z.string().optional(), case_insensitive: z.boolean().optional() }),
    async run({ pattern, path: p, case_insensitive }) {
      const start = resolveSafe(p);
      const re = new RegExp(pattern, case_insensitive ? "i" : "");
      const files = fs.statSync(start).isFile() ? [{ full: start, dir: false }] : walk(start);
      const hits = [];
      for (const f of files) {
        if (f.dir) continue;
        let buf;
        try { if (fs.statSync(f.full).size > 1_000_000) continue; buf = fs.readFileSync(f.full); } catch { continue; }
        if (isBinary(buf)) continue;
        buf.toString("utf8").split(/\r?\n/).forEach((line, i) => {
          if (hits.length < 200 && re.test(line)) hits.push(`${rel(f.full).replaceAll("\\", "/")}:${i + 1}: ${line.trim().slice(0, 300)}`);
        });
        if (hits.length >= 200) break;
      }
      console.log(dim(`  searched /${pattern}/ in ${rel(start)} → ${hits.length} match(es)`));
      return hits.length ? truncate(hits.join("\n")) : "No matches.";
    },
  },
  {
    name: "write_file",
    description: "Create a new file or completely replace an existing file. For small changes to an existing file, use edit_file instead.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root" },
        content: { type: "string", description: "The full file contents" },
      },
      required: ["path", "content"],
    },
    schema: z.object({ path: z.string().min(1), content: z.string() }),
    async run({ path: p, content }) {
      const file = resolveSafe(p);
      const exists = fs.existsSync(file);
      const lines = content.split("\n");
      const preview = `${bold(exists ? "  Overwrite" : "  Create")} ${cyan(rel(file))} (${lines.length} lines)\n`
        + lines.slice(0, 20).map((l) => green(`  + ${l}`)).join("\n")
        + (lines.length > 20 ? dim(`\n  … ${lines.length - 20} more lines`) : "");
      const ok = await approve("file changes", preview);
      if (!ok.ok) return declined(ok.feedback);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, "utf8");
      return `${exists ? "Overwrote" : "Created"} ${rel(file)} (${lines.length} lines).`;
    },
  },
  {
    name: "edit_file",
    description: "Replace an exact piece of text in a file. old_string must match the file exactly (including spaces/indentation) and appear only once, unless replace_all is true. Read the file first.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root" },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence. Default false" },
      },
      required: ["path", "old_string", "new_string"],
    },
    schema: z.object({ path: z.string().min(1), old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().optional() }),
    async run({ path: p, old_string, new_string, replace_all }) {
      const file = resolveSafe(p);
      if (!fs.existsSync(file)) throw new Error(`${p} does not exist. Use write_file to create it.`);
      const text = fs.readFileSync(file, "utf8");
      // Files saved with Windows line endings: match the model's \n text against \r\n too.
      const crlf = text.includes("\r\n") && !old_string.includes("\r\n");
      const oldS = crlf ? old_string.replaceAll("\n", "\r\n") : old_string;
      const newS = crlf ? new_string.replaceAll("\n", "\r\n") : new_string;
      const count = text.split(oldS).length - 1;
      if (count === 0) throw new Error("old_string was not found in the file. Read the file again and copy the text exactly.");
      if (count > 1 && !replace_all) throw new Error(`old_string appears ${count} times. Add more surrounding text to make it unique, or set replace_all.`);
      const ok = await approve("file changes", `${bold("  Edit")} ${cyan(rel(file))}${count > 1 ? ` (${count} places)` : ""}\n${showDiff(old_string, new_string)}`);
      if (!ok.ok) return declined(ok.feedback);
      fs.writeFileSync(file, replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS), "utf8");
      return `Edited ${rel(file)} (${replace_all ? count : 1} replacement${(replace_all ? count : 1) > 1 ? "s" : ""}).`;
    },
  },
  {
    name: "run_command",
    description: `Run a shell command in the project folder using ${shellName}. Use it for builds, tests, git, and installing packages. Don't start servers or programs that never exit. Output is limited to ${MAX_TOOL_OUTPUT} characters.`,
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        timeout_seconds: { type: "integer", description: "Stop the command after this many seconds. Default 120, max 600" },
      },
      required: ["command"],
    },
    schema: z.object({ command: z.string().min(1), timeout_seconds: z.number().int().min(1).max(600).optional() }),
    async run({ command, timeout_seconds = 120 }) {
      const ok = await approve("commands", `${bold("  Run")} ${cyan(command)}`);
      if (!ok.ok) return declined(ok.feedback);
      return runCommand(command, timeout_seconds);
    },
  },
];
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
// What the API sees: name/description/schema, with eager input streaming so big file contents stream as they're written.
const API_TOOLS = TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema, eager_input_streaming: true }));

function runCommand(command, timeoutS) {
  return new Promise((resolve) => {
    const child = process.platform === "win32"
      ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd: ROOT })
      : spawn("bash", ["-c", command], { cwd: ROOT });
    child.stdin.end();
    let out = "";
    const add = (d) => { const s = d.toString(); process.stdout.write(dim(s)); out = (out + s).slice(-200_000); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutS * 1000);
    child.on("error", (e) => { clearTimeout(timer); resolve(`Could not start the command: ${e.message}`); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(truncate(out.trim() || "(no output)") + (timedOut ? `\n[stopped after ${timeoutS}s]` : `\n[exit code ${code}]`));
    });
  });
}

async function executeTool(block) {
  const tool = TOOL_BY_NAME[block.name];
  if (!tool) return { type: "tool_result", tool_use_id: block.id, is_error: true, content: `Unknown tool: ${block.name}` };
  // With eager input streaming the API doesn't validate tool input, so check it here before running anything.
  const parsed = tool.schema.safeParse(block.input);
  if (!parsed.success) {
    console.log(red(`  ✗ ${block.name}: invalid input, asking Claude to try again`));
    return {
      type: "tool_result", tool_use_id: block.id, is_error: true,
      content: JSON.stringify({
        INVALID_JSON: JSON.stringify(block.input),
        problem: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
      }),
    };
  }
  try {
    return { type: "tool_result", tool_use_id: block.id, content: await tool.run(parsed.data) };
  } catch (e) {
    console.log(red(`  ✗ ${e.message}`));
    return { type: "tool_result", tool_use_id: block.id, is_error: true, content: e.message };
  }
}

/* ---------------------------------------------------------------- system prompt (kept identical all session so it caches) */
function projectNotes() {
  for (const name of ["AGENT.md", "CLAUDE.md"]) {
    const f = path.join(ROOT, name);
    if (fs.existsSync(f)) return `\n\nProject notes from ${name}:\n${truncate(fs.readFileSync(f, "utf8"), 20_000)}`;
  }
  return "";
}
const SYSTEM = `You are a coding agent working in the user's project folder: ${ROOT}
Operating system: ${os.type()} ${os.release()}. Shell for run_command: ${shellName}.

Use the tools to explore and change the project:
- Look around with list_files, search and read_file before changing code. Read a file before editing it.
- Use edit_file for changes to existing files and write_file for new files.
- Keep changes focused on what the user asked. Don't refactor or reformat unrelated code.
- When practical, check your work with run_command (run the tests, build, or the script).
- The user approves every file change and command and may decline. If they decline, adjust or ask; don't repeat the same action.
- When you finish, briefly say what you changed and anything the user still needs to do.${projectNotes()}`;

/* ---------------------------------------------------------------- the agent loop */
const client = new Anthropic();
let messages = [];           // the whole conversation; only ever appended to
let current = null;          // the stream in progress (so Ctrl+C can stop it)
let interrupted = false;
const totals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

function printUsage(u) {
  const read = u.cache_read_input_tokens || 0, write = u.cache_creation_input_tokens || 0;
  totals.in += u.input_tokens; totals.out += u.output_tokens; totals.cacheRead += read; totals.cacheWrite += write;
  totals.cost += (u.input_tokens * PRICE.input + u.output_tokens * PRICE.output + read * PRICE.cacheRead + write * PRICE.cacheWrite) / 1e6;
  console.log(dim(`\n  [tokens: ${u.input_tokens} in, ${read} from cache, ${write} cached, ${u.output_tokens} out · session ≈ $${totals.cost.toFixed(3)}]`));
}

async function runAgent() {
  let jsonRetries = 0;
  while (true) {
    const useFallback = FALLBACK_MODELS.has(MODEL);
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      system: SYSTEM,
      tools: API_TOOLS,
      messages,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: EFFORT },
      cache_control: { type: "ephemeral" },                 // automatic prompt caching of the growing conversation
      ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    });
    current = stream;

    let message;
    try {
      for await (const ev of stream) {
        if (ev.type === "content_block_start") {
          const b = ev.content_block;
          if (b.type === "thinking") process.stdout.write(dim("\n💭 "));
          else if (b.type === "text") process.stdout.write("\n");
          else if (b.type === "tool_use") process.stdout.write(cyan(`\n⚙ ${b.name}`) + "\n");
        } else if (ev.type === "content_block_delta") {
          if (ev.delta.type === "text_delta") process.stdout.write(ev.delta.text);
          else if (ev.delta.type === "thinking_delta") process.stdout.write(dim(ev.delta.thinking));
        }
      }
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      if (interrupted) { interrupted = false; console.log(yellow("\n(stopped)")); return; }
      if (err instanceof Anthropic.APIError) throw err;
      // A tool input that wasn't valid JSON: ask for the same turn again (max 2 times in a row).
      if (jsonRetries++ >= 2) throw err;
      console.log(yellow("\n(tool input was not valid JSON — retrying)"));
      continue;
    } finally {
      current = null;
    }

    printUsage(message.usage);
    for (const b of message.content) {
      if (b.type === "fallback") console.log(dim(`  (${b.from.model} declined; ${b.to.model} answered instead)`));
    }

    if (message.stop_reason === "refusal") {
      console.log(red(`\nClaude declined this request${message.stop_details?.category ? ` (${message.stop_details.category})` : ""}.`)
        + (message.stop_details?.explanation ? `\n${message.stop_details.explanation}` : ""));
      return;
    }
    const toolUses = message.content.filter((b) => b.type === "tool_use");
    if (message.stop_reason === "max_tokens" && toolUses.length) {
      console.log(red("\nThe response was cut off in the middle of a tool call. Try asking for smaller steps."));
      return;
    }

    messages.push({ role: "assistant", content: message.content });   // keep every block (thinking, fallback, …) unchanged
    if (message.stop_reason === "pause_turn") continue;
    if (!toolUses.length) return;                                      // Claude is done

    const results = [];
    for (const block of toolUses) results.push(await executeTool(block));
    messages.push({ role: "user", content: results });                 // all results together in one message
  }
}

/* ---------------------------------------------------------------- main */
rl.on("SIGINT", () => {
  if (current) { interrupted = true; current.abort(); return; }
  console.log("\nBye!");
  process.exit(0);
});

console.log(bold(cyan("mini-agent")) + dim(` · ${MODEL} · effort ${EFFORT}`));
console.log(dim(`Project: ${ROOT}`));
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.log(yellow(`No ANTHROPIC_API_KEY found. Put it in ${path.join(HERE, ".env")} (see README.md).`));
}
console.log(dim("Type what you want done. Commands: /clear (new conversation), /exit. Ctrl+C stops Claude mid-answer.\n"));

while (true) {
  let input;
  try { input = (await rl.question(bold(green("\n> ")))).trim(); } catch { break; }
  if (!input) continue;
  if (input === "/exit" || input === "/quit") break;
  if (input === "/clear") { messages = []; alwaysAllow.clear(); console.log(dim("Started a new conversation.")); continue; }
  if (input === "/help") { console.log("Just describe the coding task. /clear starts over, /exit quits."); continue; }

  messages.push({ role: "user", content: input });
  try {
    await runAgent();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) console.log(red("\nYour API key was rejected. Check ANTHROPIC_API_KEY in .env."));
    else if (err instanceof Anthropic.PermissionDeniedError) console.log(red(`\nPermission denied: ${err.message}`));
    else if (err instanceof Anthropic.RateLimitError) console.log(red("\nRate limit reached. Wait a minute and try again."));
    else if (err instanceof Anthropic.BadRequestError) console.log(red(`\nRequest rejected: ${err.message}`));
    else if (err instanceof Anthropic.APIConnectionError) console.log(red("\nCould not reach the Claude API. Check your internet connection."));
    else if (err instanceof Anthropic.APIError) console.log(red(`\nAPI error ${err.status ?? ""}: ${err.message}`));
    else if (err instanceof Anthropic.AnthropicError) console.log(red(`\n${err.message}`));
    else console.log(red(`\nUnexpected error: ${err?.stack || err}`));
    // History stays valid: a failed request is never appended, and tool calls always get results,
    // so the conversation ends on a user turn and the next message simply continues it.
  }
}
rl.close();
