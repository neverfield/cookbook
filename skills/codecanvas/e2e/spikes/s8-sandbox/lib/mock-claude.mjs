#!/usr/bin/env node
/**
 * Protocol-accurate stub of `claude -p --output-format stream-json --verbose --settings <file>`.
 *
 * Used when the real `claude` CLI is not installed in the test environment so the
 * full headless runner contract, NDJSON streaming parser, PreToolUse hook subprocess
 * protocol, and OS sandbox confinement can be exercised deterministically end-to-end.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const opts = { prompt: '', outputFormat: 'text', verbose: false, settingsPath: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-p' || arg === '--print') {
      opts.prompt = argv[++i] ?? '';
    } else if (arg === '--output-format') {
      opts.outputFormat = argv[++i] ?? 'text';
    } else if (arg === '--verbose') {
      opts.verbose = true;
    } else if (arg === '--settings') {
      opts.settingsPath = argv[++i] ?? null;
    } else if (arg === '--permission-mode' || arg === '--allowedTools' || arg === '--mcp-config') {
      i++;
    }
  }
  return opts;
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function runPreToolUseHooks(settings, sessionId, cwd, toolName, toolInput) {
  const hookGroups = settings?.hooks?.PreToolUse ?? [];
  for (const group of hookGroups) {
    const matcher = group.matcher ? new RegExp(`^(?:${group.matcher})$`) : /.*/;
    if (!matcher.test(toolName)) continue;
    for (const hook of group.hooks ?? []) {
      if (hook.type !== 'command' || !hook.command) continue;
      const payload = {
        session_id: sessionId,
        cwd,
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: toolInput,
      };
      const parts = hook.command.split(/\s+/);
      const res = spawnSync(parts[0], parts.slice(1), {
        cwd,
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: (hook.timeout ?? 10) * 1000,
      });

      if (res.status === 2) {
        return {
          allow: false,
          reason: (res.stderr || 'Hook exited with status 2').trim(),
        };
      }
      if (res.status !== 0) {
        return {
          allow: false,
          reason: `Hook failed (exit ${res.status}): ${(res.stderr || '').trim()}`,
        };
      }

      const out = (res.stdout || '').trim();
      if (out) {
        const parsed = JSON.parse(out);
        const decision = parsed?.hookSpecificOutput?.permissionDecision;
        if (decision === 'deny') {
          return {
            allow: false,
            reason: parsed?.hookSpecificOutput?.permissionDecisionReason ?? 'Denied by PreToolUse hook',
          };
        }
      }
    }
  }
  return { allow: true };
}

function executeTool(cwd, toolName, toolInput) {
  try {
    if (toolName === 'Write') {
      const target = path.resolve(cwd, toolInput.file_path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, toolInput.content ?? '', 'utf8');
      return { content: `Wrote ${target}`, isError: false };
    }
    if (toolName === 'Read') {
      const target = path.resolve(cwd, toolInput.file_path);
      const data = fs.readFileSync(target, 'utf8');
      return { content: data, isError: false };
    }
    if (toolName === 'Bash') {
      const res = spawnSync('sh', ['-c', toolInput.command], {
        cwd,
        encoding: 'utf8',
        timeout: 15_000,
      });
      const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
      return {
        content: combined || `(exit ${res.status})`,
        isError: res.status !== 0,
      };
    }
    return { content: `Unknown tool: ${toolName}`, isError: true };
  } catch (err) {
    return { content: `${err.code ?? 'ERR'}: ${err.message}`, isError: true };
  }
}

function main() {
  const started = Date.now();
  const opts = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const sessionId = `mock-session-${process.pid}`;

  if (opts.outputFormat === 'stream-json' && !opts.verbose) {
    process.stderr.write('Error: --output-format stream-json requires --verbose\n');
    process.exit(1);
  }

  const settings = opts.settingsPath ? JSON.parse(fs.readFileSync(opts.settingsPath, 'utf8')) : {};
  const scenarioPath = process.env.MOCK_CLAUDE_SCENARIO;
  const steps = scenarioPath ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) : [];

  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd,
    tools: ['Read', 'Write', 'Edit', 'Bash'],
  });

  let turn = 0;
  for (const step of steps) {
    turn += 1;
    const toolUseId = `toolu_${turn}`;
    emit({
      type: 'assistant',
      message: {
        id: `msg_${turn}`,
        role: 'assistant',
        content: [
          ...(step.thought ? [{ type: 'text', text: step.thought }] : []),
          { type: 'tool_use', id: toolUseId, name: step.tool, input: step.input },
        ],
      },
    });

    const hookResult = runPreToolUseHooks(settings, sessionId, cwd, step.tool, step.input);
    let result;
    if (!hookResult.allow) {
      result = { content: hookResult.reason, isError: true };
    } else {
      result = executeTool(cwd, step.tool, step.input);
    }

    emit({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: result.content,
            is_error: result.isError,
          },
        ],
      },
    });
  }

  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: Date.now() - started,
    num_turns: turn,
    result: `Completed mock headless run for prompt: ${opts.prompt}`,
    session_id: sessionId,
  });
}

main();
