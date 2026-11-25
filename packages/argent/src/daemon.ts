import { execFile, fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { DriverRequest } from './driver.ts';

const exec = promisify(execFile);

/** The installed agent-device package: its version and CLI entry, found without importing its private modules. */
export function agentDevice(): { version: string; bin: string } {
  let directory = path.dirname(fileURLToPath(import.meta.resolve('agent-device')));
  while (true) {
    const file = path.join(directory, 'package.json');
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(file, 'utf8'));
    } catch { /* the entry may be several directories below its package */ }
    if (isRecord(manifest) && manifest['name'] === 'agent-device') {
      const version = manifest['version'];
      const bin = isRecord(manifest['bin']) ? manifest['bin']['agent-device'] : undefined;
      if (typeof version !== 'string' || typeof bin !== 'string') throw new Error(`${file} declares no version or agent-device bin`);
      return { version, bin: path.join(directory, bin) };
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Cannot find the installed agent-device package');
    directory = parent;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Starts the agent-device daemon in `request.stateDir` with `env`, from a separate process so the runner's own environment is untouched. */
export function startDaemon(request: DriverRequest, env: NodeJS.ProcessEnv): Promise<void> {
  const entry = new URL(import.meta.url.endsWith('.ts') ? './driver.ts' : './driver.js', import.meta.url);
  return new Promise((resolve, reject) => {
    const child = fork(entry, [], { env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let answered = false;
    child.once('error', reject);
    child.once('message', (reply: { ok?: boolean; error?: string }) => {
      answered = true;
      if (reply.ok) resolve();
      else reject(new Error(reply.error ?? 'the Argent driver returned no answer'));
    });
    child.once('exit', () => {
      if (!answered) reject(new Error('the Argent driver exited before the daemon started'));
    });
    child.send(request);
  });
}

/**
 * Stops the daemon in `stateDir`, and with it the runner it keeps on the leased simulator. A lease's
 * daemon never idles out, so one that is still alive a few seconds after `daemon stop` is killed.
 */
export async function stopDaemon(stateDir: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const pid = daemonPid(stateDir);
  try {
    await exec(process.execPath, [agentDevice().bin, 'daemon', 'stop', '--state-dir', stateDir, '--clean', '--json'], { env, signal });
  } finally {
    if (pid !== undefined) await reap(pid);
  }
}

function daemonPid(stateDir: string): number | undefined {
  try {
    const info: unknown = JSON.parse(readFileSync(path.join(stateDir, 'daemon.json'), 'utf8'));
    return isRecord(info) && typeof info['pid'] === 'number' ? info['pid'] : undefined;
  } catch {
    return undefined;
  }
}

async function reap(pid: number): Promise<void> {
  if (await exited(pid, 5000)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  if (await exited(pid, 3000)) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone meanwhile */ }
}

async function exited(pid: number, withinMs: number): Promise<boolean> {
  for (const deadline = Date.now() + withinMs; ; await new Promise((resolve) => setTimeout(resolve, 200))) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
  }
}
