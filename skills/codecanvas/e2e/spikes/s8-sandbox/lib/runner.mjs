import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { SandboxUnavailableError, wrapForLinuxSandbox } from './sandbox-linux.mjs';
import { wrapForMacosSandbox } from './sandbox-macos.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PRETOOLUSE_HOOK_PATH = path.join(__dirname, 'pretooluse-hook.mjs');
export const MOCK_CLAUDE_PATH = path.join(__dirname, 'mock-claude.mjs');

/**
 * Generates an ephemeral Claude Code `--settings` JSON file inside scratchDir
 * (never inside the repo, preserving I1 zero footprint).
 */
export function buildClaudeSettings({ cloneDir, scratchDir, parentRepoDir, secretsPath, hookPath = PRETOOLUSE_HOOK_PATH }) {
  const realClone = fs.realpathSync(cloneDir);
  const realScratch = fs.realpathSync(scratchDir);
  const denyWrite = parentRepoDir ? [fs.realpathSync(parentRepoDir)] : [];
  const denyRead = secretsPath ? [secretsPath] : [];

  return {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [realClone, realScratch],
        denyWrite,
        denyRead,
      },
      network: {
        allowedDomains: [],
      },
    },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
          hooks: [
            {
              type: 'command',
              command: `${process.execPath} ${hookPath}`,
              timeout: 10,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Parses one NDJSON line emitted by `claude -p --output-format stream-json --verbose`
 * into normalized codecanvas AgentEvents.
 */
export function parseStreamJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return [{ type: 'raw_non_json', line: trimmed }];
  }

  if (msg.type === 'system' && msg.subtype === 'init') {
    return [
      {
        type: 'init',
        sessionId: msg.session_id ?? null,
        cwd: msg.cwd ?? null,
        tools: msg.tools ?? [],
      },
    ];
  }

  if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
    const events = [];
    for (const block of msg.message.content) {
      if (block.type === 'text') {
        events.push({ type: 'assistant_text', text: block.text });
      } else if (block.type === 'tool_use') {
        events.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }
    return events;
  }

  if (msg.type === 'user' && msg.message && Array.isArray(msg.message.content)) {
    const events = [];
    for (const block of msg.message.content) {
      if (block.type === 'tool_result') {
        events.push({
          type: 'tool_result',
          toolUseId: block.tool_use_id,
          content: block.content,
          isError: Boolean(block.is_error),
        });
      }
    }
    return events;
  }

  if (msg.type === 'result') {
    return [
      {
        type: 'result',
        subtype: msg.subtype ?? 'unknown',
        isError: Boolean(msg.is_error),
        durationMs: msg.duration_ms ?? null,
        numTurns: msg.num_turns ?? null,
        result: msg.result ?? '',
        sessionId: msg.session_id ?? null,
      },
    ];
  }

  return [{ type: 'unknown', raw: msg }];
}

function killProcessGroup(pid, signal = 'SIGTERM') {
  if (!pid || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if (err.code !== 'ESRCH') {
      try {
        process.kill(pid, signal);
      } catch {
        // already exited
      }
    }
  }
}

/**
 * Headless AgentRunner implementing architecture-v2.md §5 / §10.2.
 *
 * Wraps the spawned CLI process in the platform OS sandbox (fail-closed)
 * AND injects the PreToolUse containment hook via ephemeral `--settings`.
 */
export async function* runHeadlessAgentTask(task, clone, options) {
  const {
    probe,
    backend = 'auto',
    disableAllBackends = false,
    useRealClaude = false,
    timeoutMs = 30_000,
    extraEnv = {},
  } = options;

  const settings = buildClaudeSettings({
    cloneDir: clone.cloneDir,
    scratchDir: clone.scratchDir,
    parentRepoDir: clone.parentRepoDir,
    secretsPath: clone.secretsPath,
  });

  const settingsPath = path.join(clone.scratchDir, 'claude-settings.json');
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });

  let cliBin;
  let cliArgs;
  if (useRealClaude) {
    if (!probe.claude.available) {
      throw new Error('useRealClaude=true requested, but `claude` CLI is not installed in PATH.');
    }
    cliBin = probe.claude.path;
    cliArgs = [
      '-p',
      task.request,
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--settings',
      settingsPath,
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Read,Edit,Write,Glob,Grep,Bash',
    ];
  } else {
    cliBin = process.execPath;
    cliArgs = [
      MOCK_CLAUDE_PATH,
      '-p',
      task.request,
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--settings',
      settingsPath,
      '--permission-mode',
      'acceptEdits',
    ];
  }

  const sandboxOpts = {
    cloneDir: clone.cloneDir,
    scratchDir: clone.scratchDir,
    cwd: clone.cloneDir,
    extraAllowRo: clone.parentRepoDir ? [clone.parentRepoDir] : [],
    maskReadPaths: clone.secretsPath ? [clone.secretsPath] : [],
    denyReadPaths: clone.secretsPath ? [clone.secretsPath] : [],
    disableAllBackends,
    env: {
      ...extraEnv,
      ...(task.scenarioPath ? { MOCK_CLAUDE_SCENARIO: task.scenarioPath } : {}),
    },
  };

  let wrapped;
  if (process.platform === 'linux') {
    wrapped = wrapForLinuxSandbox(cliBin, cliArgs, sandboxOpts, probe, backend);
  } else if (process.platform === 'darwin') {
    wrapped = wrapForMacosSandbox(cliBin, cliArgs, sandboxOpts, probe);
  } else {
    throw new SandboxUnavailableError(
      `Unsupported platform "${process.platform}": OS sandbox not available (no weaker fallback).`,
    );
  }

  const child = spawn(wrapped.command, wrapped.args, {
    cwd: clone.cloneDir,
    env: wrapped.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrChunks = [];
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessGroup(child.pid, 'SIGTERM');
    setTimeout(() => killProcessGroup(child.pid, 'SIGKILL'), 1500).unref();
  }, timeoutMs);
  timer.unref();

  const exitPromise = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  try {
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      for (const evt of parseStreamJsonLine(line)) {
        yield evt;
      }
    }
    const { code, signal } = await exitPromise;
    yield {
      type: 'process_exit',
      code,
      signal,
      timedOut,
      backend: wrapped.backend,
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    };
  } finally {
    clearTimeout(timer);
    killProcessGroup(child.pid, 'SIGTERM');
  }
}
