#!/usr/bin/env node
// Trav guard hook (PreToolUse, all tools, main session + subagents).
// Second layer on top of the OS sandbox and permission rules:
//   1. File tools may only touch the repo (and temp dirs).
//   2. Only research agents may use the web; research agents may only write markdown
//      in research/, docs/, tasks/ (and adapter interfaces for connector-scout).
//   3. Bash: blocks risky commands, paths outside the repo, and pushes to anything
//      but this repo's origin.
// Exit 2 = block (stderr is shown to Claude). Fails closed on any error.
// Every block is appended to .claude/hooks/blocked.log for the morning report.

import { readFileSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

let input = {};
const ROOT = (() => {
  try { return realpathSync(process.env.CLAUDE_PROJECT_DIR || process.cwd()); }
  catch { return path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd()); }
})();
const LOG = path.join(ROOT, '.claude', 'hooks', 'blocked.log');

function block(reason) {
  try {
    appendFileSync(LOG, JSON.stringify({
      at: new Date().toISOString(), agent: input.agent_type || 'main',
      tool: input.tool_name, input: input.tool_input, reason,
    }) + '\n');
  } catch { /* logging must never unblock */ }
  process.stderr.write(`BLOCKED by Trav guard: ${reason}\n`);
  process.exit(2);
}

const RESEARCH_AGENTS = new Set(['market-researcher', 'gap-hunter', 'connector-scout', 'ideation']);
const RESEARCH_WRITE_DIRS = ['research', 'docs', 'tasks', 'packages/adapters/src/interfaces'];
const SYSTEM_PREFIXES = ['/usr', '/bin', '/sbin', '/opt/homebrew', '/usr/local', '/dev/null',
  '/dev/stdout', '/dev/stderr', '/dev/stdin', '/dev/tty', '/Library/Developer/CommandLineTools'];

function realish(p) {
  // Resolve symlinks on the deepest existing ancestor so links can't escape the repo.
  let cur = p; const rest = [];
  while (!existsSync(cur) && path.dirname(cur) !== cur) { rest.unshift(path.basename(cur)); cur = path.dirname(cur); }
  try { cur = realpathSync(cur); } catch { /* keep as is */ }
  return path.join(cur, ...rest);
}
function resolvePath(p, base) {
  if (typeof p !== 'string' || !p) return null;
  let s = p.replace(/^["']|["']$/g, '');
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(1));
  s = s.replace(/^\$HOME|^\$\{HOME\}/, os.homedir());
  return realish(path.resolve(base, s));
}
function inside(p, dir) {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function tempDirs() {
  const dirs = ['/tmp', '/private/tmp', os.tmpdir()];
  if (input.scratchpad_dir) dirs.push(input.scratchpad_dir);
  return dirs.map((d) => { try { return realpathSync(d); } catch { return d; } });
}
function allowedPath(p) {
  return inside(p, ROOT) || tempDirs().some((d) => inside(p, d));
}

function checkFileTool(tool, ti, agent) {
  const base = input.cwd || ROOT;
  const raw = ti.file_path ?? ti.notebook_path ?? ti.path ?? null;
  const candidates = [raw];
  if (tool === 'Glob' && typeof ti.pattern === 'string' && /^(\/|~|\$HOME)/.test(ti.pattern)) candidates.push(ti.pattern);
  for (const c of candidates) {
    if (c == null) continue;
    const p = resolvePath(c.replace(/\*.*$/, '') || '.', base);
    if (!p || !allowedPath(p)) block(`${tool} outside the Trav repo is not allowed: ${c}`);
  }
  const p = raw != null ? resolvePath(raw, base) : null;
  if (p && /(^|\/)\.git\/(config|trav-credentials)$/.test(p) && tool !== 'Read') {
    block('Editing git config or credentials is not allowed.');
  }
  if (p && /(^|\/)\.claude\/(settings(\.local)?\.json|hooks\/)/.test(p) && ['Write', 'Edit', 'NotebookEdit'].includes(tool)) {
    block('Agents may not modify Claude Code settings or the guard hook.');
  }
  if (RESEARCH_AGENTS.has(agent) && ['Write', 'Edit', 'NotebookEdit'].includes(tool)) {
    const ok = p && RESEARCH_WRITE_DIRS.some((d) => inside(p, path.join(ROOT, d)));
    if (!ok) block(`Research agents may only write in ${RESEARCH_WRITE_DIRS.join(', ')}.`);
  }
}

const BASH_DENY = [
  [/\bsudo\b/, 'sudo'],
  [/(^|[\s;&|(])gh\s/, 'the gh CLI (uses your global GitHub login)'],
  [/\b(ssh|scp|sftp|rsync|nc|ncat|telnet)\b/, 'remote shell / file transfer tools'],
  [/\b(curl|wget)\b[^\n]*\|\s*(ba|z|)sh\b/, 'piping downloads into a shell'],
  [/\bgit\s+config\s+(--global|--system)\b/, 'changing global git config'],
  [/\bgit\s+config\b[^\n]*credential/, 'changing git credentials'],
  [/\bgit\s+remote\s+(add|set-url|rename|remove|rm)\b/, 'changing git remotes'],
  [/\bgit\s+(clone|submodule)\b/, 'cloning other repositories'],
  [/\bgit\s+add\b[^\n]*(-f|--force)\b[^\n]*\.env/, 'force-adding .env'],
  [/\b(npm|pnpm|yarn)\s+(i|install|add)\s+(-g|--global)\b/, 'global package installs'],
  [/\bnpx\s+(-y|--yes)\b/, 'npx auto-install'],
  [/\b(osascript|launchctl|crontab|defaults\s+write|security\s+(find|dump|export))\b/, 'macOS system / keychain tools'],
  [/\bchmod\s+[^\n]*\s\/(\s|$)/, 'chmod on /'],
  [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)/i, 'rm -rf on / or home'],
  [/\b(printenv|env)\s*(\||>|$)/, 'dumping environment variables'],
  [/\bcat\b[^\n]*\.git\/trav-credentials/, 'reading git credentials'],
];

function checkBash(cmd) {
  for (const [re, what] of BASH_DENY) if (re.test(cmd)) block(`Not allowed: ${what}. Command: ${cmd.slice(0, 200)}`);

  // Path-like tokens (absolute, home, or with ..) must stay inside the repo or system dirs.
  const base = input.cwd || ROOT;
  const tokenRe = /(?:^|[\s'"=:(<>])((?:~|\$HOME|\$\{HOME\}|\/(?!\/)|\.\.)[^\s'";|&)<>]*)/g;
  for (const m of cmd.matchAll(tokenRe)) {
    const tok = m[1];
    if (!tok || tok.startsWith('//')) continue; // URLs
    if (tok.startsWith('/') && SYSTEM_PREFIXES.some((s) => tok === s || tok.startsWith(s + '/'))) continue;
    if (/^\/[a-z]+\/[^/]*$/i.test(tok) && /\s(sed|awk|grep|rg)\b/.test(' ' + cmd) && !existsSync(tok)) continue; // regex-ish
    const p = resolvePath(tok.replace(/[*?].*$/, '') || '/', base);
    if (p && !allowedPath(p)) block(`Path outside the Trav repo: ${tok}`);
  }

  // git push: only to origin, and origin must be this repo.
  if (/\bgit\b[^\n]*\bpush\b/.test(cmd)) {
    const expected = process.env.TRAV_REPO_URL;
    let origin = '';
    try { origin = execFileSync('git', ['-C', ROOT, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim(); } catch { /* none */ }
    if (!origin) block('No origin remote configured; pushing is disabled.');
    if (expected && origin.replace(/\.git$/, '') !== expected.replace(/\.git$/, '')) {
      block(`origin (${origin}) is not the Trav repo (${expected}).`);
    }
    const after = cmd.split(/\bpush\b/)[1] || '';
    const args = after.split(/[;&|]/)[0].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
    if (args[0] && args[0] !== 'origin') block(`Push only to origin, not "${args[0]}".`);
  }
}

try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  const agent = input.agent_type || 'main';

  if (tool === 'WebFetch' || tool === 'WebSearch') {
    if (!RESEARCH_AGENTS.has(agent)) {
      block(`Only research agents (${[...RESEARCH_AGENTS].join(', ')}) may use the web. Ask the orchestrator to run one.`);
    }
  } else if (['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'].includes(tool)) {
    checkFileTool(tool, ti, agent);
  } else if (tool === 'Bash') {
    if (RESEARCH_AGENTS.has(agent)) block('Research agents may not run shell commands.');
    checkBash(String(ti.command || ''));
  } else if (tool.startsWith('mcp__')) {
    block('MCP tools are disabled for the overnight run.');
  }
  process.exit(0);
} catch (e) {
  block(`Guard error (failing closed): ${e && e.message}`);
}
