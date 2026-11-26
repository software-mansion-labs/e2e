import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** One `sim-remote` session: its own daemon, login and machine, named by `SIM_REMOTE_SESSION`. */
export interface CloudSession {
  /** The `sim-remote` executable. */
  readonly bin: string;
  /** Environment every `sim-remote` call of this session runs with. */
  readonly env: NodeJS.ProcessEnv;
}

export interface Simulator {
  readonly udid: string;
  readonly name: string;
  readonly state: string;
  readonly runtime: string;
}

export async function simRemote(session: CloudSession, args: readonly string[], signal?: AbortSignal, timeoutMs = 120_000): Promise<string> {
  try {
    const { stdout } = await exec(session.bin, [...args], { env: session.env, signal, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (cause) {
    if (signal?.aborted) throw signal.reason;
    const detail = typeof cause === 'object' && cause !== null && 'stderr' in cause ? String(cause.stderr).trim() : '';
    throw new Error(`sim-remote ${args[0]} failed${detail === '' ? '' : `: ${detail}`}`, { cause });
  }
}

/** Logs the session in and waits up to `timeoutSeconds` for a machine. Returns the machine's name. */
export async function login(session: CloudSession, timeoutSeconds: number, signal: AbortSignal): Promise<string> {
  // The API key travels in SIM_ROUTER_API_KEY, not in argv where `ps` would show it.
  const out = await simRemote(session, ['login', '--timeout', String(timeoutSeconds)], signal, (timeoutSeconds + 60) * 1000);
  return /Acquired machine (\S+?)\.?$/m.exec(out)?.[1] ?? 'a machine';
}

/** Releases the machine, then stops the session's daemon, which `logout` leaves running. */
export async function logout(session: CloudSession, signal: AbortSignal): Promise<void> {
  await simRemote(session, ['logout'], signal, 60_000);
  await simRemote(session, ['daemon', 'stop'], signal, 30_000);
}

export async function simulators(session: CloudSession, signal: AbortSignal): Promise<Simulator[]> {
  const list: unknown = JSON.parse(await simRemote(session, ['simctl', 'list', 'devices', 'available', '-j'], signal));
  const runtimes = isRecord(list) && isRecord(list['devices']) ? list['devices'] : {};
  return Object.entries(runtimes)
    .filter(([runtime]) => runtime.includes('SimRuntime.iOS'))
    .flatMap(([runtime, devices]) => (Array.isArray(devices) ? devices : []).flatMap((device: unknown) => {
      if (!isRecord(device)) return [];
      const { udid, name, state } = device;
      return typeof udid === 'string' && typeof name === 'string' && typeof state === 'string' ? [{ udid, name, state, runtime }] : [];
    }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The simulator to lease: the one named `name`, else a booted iPhone, else the
 * first iPhone, newest runtime first.
 */
export function pickSimulator(available: readonly Simulator[], name: string | undefined): Simulator | undefined {
  const newestFirst = available.toSorted((a, b) => runtimeVersion(b.runtime) - runtimeVersion(a.runtime));
  if (name !== undefined) return newestFirst.find((device) => device.name === name);
  const phones = newestFirst.filter((device) => device.name.startsWith('iPhone'));
  return phones.find((device) => device.state === 'Booted') ?? phones[0];
}

function runtimeVersion(runtime: string): number {
  const [major = 0, minor = 0] = (/iOS-(\d+)-(\d+)/.exec(runtime) ?? []).slice(1).map(Number);
  return major * 1000 + minor;
}

export async function boot(session: CloudSession, udid: string, signal: AbortSignal): Promise<void> {
  await simRemote(session, ['simctl', 'bootstatus', udid, '-b'], signal, 300_000);
}

/** Writes sim-remote's own shims into `directory`: its xcrun forwards simctl. */
export async function installShims(session: CloudSession, directory: string, signal: AbortSignal): Promise<void> {
  await simRemote(session, ['install-shims', '--dir', directory, '--shell', 'posix'], signal);
}

/** Opens `sim-remote reverse` so the simulator reaches `port` on this machine (a dev server). */
export async function reverse(session: CloudSession, udid: string, port: number, signal: AbortSignal): Promise<void> {
  await simRemote(session, ['reverse', 'start', udid, String(port)], signal);
}
