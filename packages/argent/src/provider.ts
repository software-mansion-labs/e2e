import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { DeviceProvider, DeviceRequest } from '@e2e-dev/mobile';
import { ConfigurationError, rejectUnknownKeys } from 'e2e/engine';
import { boot, type CloudSession, installShims, login, logout, pickSimulator, reverse, simRemote, simulators } from './cloud.ts';
import { agentDevice, startDaemon, stopDaemon } from './daemon.ts';

const exec = promisify(execFile);

export interface ArgentOptions {
  /** Simulator to lease by name, such as `'iPhone 17 Pro'`. Defaults to a booted iPhone, else the first iPhone on the newest iOS. */
  readonly device?: string;
  /** Seconds to wait for a free machine. Defaults to 600. */
  readonly acquireTimeout?: number;
  /** Local ports the simulator reaches on this machine, such as a Metro dev server's `8081`. */
  readonly reversePorts?: readonly number[];
  /** The `sim-remote` executable. Defaults to `SIM_REMOTE_BIN` in the run environment, then `sim-remote` on `PATH`. */
  readonly simRemote?: string;
}

/** What `acquire` holds for one lease until `release`. */
interface Held {
  readonly dir: string;
  readonly stateDir: string;
  readonly session: CloudSession;
  readonly daemonEnv: NodeJS.ProcessEnv;
  keepalive?: NodeJS.Timeout;
  daemonStarted?: boolean;
}

const SHIMS = fileURLToPath(new URL('../shims/', import.meta.url));

/**
 * One Argent Cloud machine and simulator per worker slot, driven by a local
 * agent-device daemon whose `xcrun simctl` and runner launch go to the cloud
 * through `sim-remote`, the same way Argent Cloud runs Maestro.
 */
export function argent(options: ArgentOptions = {}): DeviceProvider {
  rejectUnknownKeys('argent()', options, ['device', 'acquireTimeout', 'reversePorts', 'simRemote']);
  const held = new Map<string, Held>();

  async function release(id: string, resource: Held, signal: AbortSignal): Promise<void> {
    clearInterval(resource.keepalive);
    const errors: unknown[] = [];
    if (resource.daemonStarted) await stopDaemon(resource.stateDir, resource.daemonEnv, signal).catch((error: unknown) => errors.push(error));
    // Logging out releases the machine; the orchestrator erases its simulators for the next tenant.
    await logout(resource.session, signal).catch((error: unknown) => errors.push(error));
    for (const kept of ['home', 'state']) {
      await cp(path.join(resource.dir, kept), path.join(cacheDir(), 'logs', `${id}.${kept}`), { recursive: true, filter: (source) => !source.includes(`${path.sep}derived`) }).catch(() => {});
    }
    await rm(resource.dir, { recursive: true, force: true });
    held.delete(id);
    if (errors.length > 0) throw new AggregateError(errors, `Could not fully release Argent Cloud session ${id}: ${errors.map(messageOf).join('; ')}`);
  }

  return {
    name: 'Argent Cloud',
    async acquire(request) {
      if (request.platform !== 'ios') throw new ConfigurationError('INVALID_CONFIG', 'argent() runs iOS simulators only; Argent Cloud has no Android emulators yet');
      const apiKey = request.env['ARGENT_CLOUD_API_KEY']?.trim();
      if (!apiKey) throw new ConfigurationError('INVALID_CONFIG', 'argent() requires ARGENT_CLOUD_API_KEY in the run environment');
      const installed = agentDevice().version;
      if (installed !== request.agentDeviceVersion) throw new Error(`@e2e-dev/argent uses agent-device ${installed}, but @e2e-dev/mobile uses ${request.agentDeviceVersion}. Install matching versions.`);
      request.signal.throwIfAborted();

      const dir = await mkdtemp(path.join(tmpdir(), 'e2e-argent-'));
      const name = `e2e-${createHash('sha256').update(dir).digest('hex').slice(0, 12)}`;
      const hostPath = request.env['PATH'] ?? process.env['PATH'] ?? '';
      const bin = options.simRemote ?? request.env['SIM_REMOTE_BIN'] ?? 'sim-remote';
      const session: CloudSession = {
        bin,
        env: {
          ...definedEnv(request.env),
          SIM_REMOTE_SESSION: name,
          SIM_ROUTER_API_KEY: apiKey,
          ...(request.env['ARGENT_CLOUD_URL'] ? { SIM_ROUTER_URL: request.env['ARGENT_CLOUD_URL'] } : {}),
        },
      };
      const binDir = path.join(dir, 'bin');
      const simRemoteShims = path.join(dir, 'sim-remote-shims');
      const resource: Held = {
        dir,
        stateDir: path.join(dir, 'state'),
        session,
        daemonEnv: {
          ...withoutAgentDeviceSettings(session.env),
          PATH: `${binDir}:${hostPath}`,
          ARGENT_HOST_PATH: hostPath,
          ARGENT_SIM_REMOTE: bin,
          ARGENT_SIM_REMOTE_SHIMS: simRemoteShims,
          SIM_REMOTE_BIN: bin,
          AGENT_DEVICE_HOME: path.join(dir, 'home'),
          // Kept after release, for a lease that went wrong.
          ARGENT_SHIM_LOG: path.join(cacheDir(), 'logs', `${name}.shims.log`),
          // The daemon must outlive idle stretches: a worker that found it gone would start one without the shims.
          AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
          // Where the shim lays out the release runner as agent-device's build; kept between runs.
          AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH: path.join(cacheDir(), `agent-device-${installed}-release`, `slot-${request.slot}`),
          // The daemon believes it runs on a Mac, whose xcrun, xcodebuild and plutil are the shims.
          NODE_OPTIONS: [session.env['NODE_OPTIONS'], `--require ${JSON.stringify(path.join(SHIMS, 'agent-device-host.cjs'))}`].filter(Boolean).join(' '),
        },
      };
      held.set(name, resource);
      try {
        const machine = await login(session, options.acquireTimeout ?? 600, request.signal);
        request.log(`${name}: acquired ${machine}`);
        resource.keepalive = setInterval(() => { void simRemote(session, ['keepalive']).catch(() => {}); }, 60_000);
        resource.keepalive.unref();

        const simulator = pickSimulator(await simulators(session, request.signal), options.device);
        if (!simulator) throw new ConfigurationError('INVALID_CONFIG', options.device === undefined ? `Argent Cloud machine ${machine} has no iPhone simulator` : `Argent Cloud machine ${machine} has no simulator named "${options.device}"`);
        if (simulator.state !== 'Booted') request.log(`${name}: booting ${simulator.name}`);
        await boot(session, simulator.udid, request.signal);

        await mkdir(binDir, { recursive: true });
        await mkdir(path.join(cacheDir(), 'logs'), { recursive: true });
        for (const shim of ['xcodebuild', 'xcrun', 'plutil']) {
          await copyFile(path.join(SHIMS, shim), path.join(binDir, shim));
          await chmod(path.join(binDir, shim), 0o755);
        }
        await copyFile(path.join(SHIMS, 'xctestconfiguration.plist'), path.join(binDir, 'xctestconfiguration.plist'));
        await installShims(session, simRemoteShims, request.signal);
        resource.daemonEnv['ARGENT_RUNNER_APP'] = await releaseRunner(installed, request.signal);
        if (process.platform !== 'darwin') resource.daemonEnv['DEVELOPER_DIR'] = await standInXcode(dir);
        for (const port of options.reversePorts ?? []) await reverse(session, simulator.udid, port, request.signal);

        resource.daemonStarted = true;
        await startDaemon({ stateDir: resource.stateDir, udid: simulator.udid }, resource.daemonEnv);
        request.log(`${name}: ${simulator.name} (${simulator.udid})`);
        const lease = { id: name, client: { stateDir: resource.stateDir }, deviceId: simulator.udid };
        if (request.appPath === undefined) return lease;
        // Install the build here, as hosted providers do, so the suite needs no install fixture.
        await simRemote(session, ['simctl', 'install', simulator.udid, request.appPath], request.signal, 600_000);
        const installedApp = request.app ?? await bundleId(request.appPath, resource.daemonEnv);
        request.log(`${name}: installed ${installedApp}`);
        return { ...lease, installedApp };
      } catch (cause) {
        try {
          await release(name, resource, AbortSignal.timeout(60_000));
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], `Argent Cloud lease failed: ${messageOf(cause)}; cleanup also failed: ${messageOf(cleanup)}`, { cause: cleanup });
        }
        throw cause;
      }
    },
    async release(lease, context) {
      const resource = held.get(lease.id);
      if (resource) await release(lease.id, resource, context.signal);
    },
  };
}

/**
 * agent-device's own prebuilt runner for `version`, from its GitHub release, checked against the
 * release manifest's sha256 and kept in the cache. It is what Limrun runs, and it needs no Xcode here.
 */
async function releaseRunner(version: string, signal: AbortSignal): Promise<string> {
  const app = path.join(cacheDir(), `runner-${version}`, 'Runner.app');
  if (await stat(app).then(() => true, () => false)) return app;
  const base = `https://github.com/callstack/agent-device/releases/download/v${version}/agent-device-ios-runner-${version}`;
  const manifest: unknown = await (await download(`${base}.manifest.json`, signal)).json();
  const sha256 = isRecord(manifest) ? manifest['sha256'] : undefined;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) || isRecord(manifest) && manifest['platform_target'] !== 'iphonesimulator') {
    throw new Error(`agent-device ${version} publishes no iOS simulator runner manifest`);
  }
  const archive = Buffer.from(await (await download(`${base}.app.tar.gz`, signal)).arrayBuffer());
  if (createHash('sha256').update(archive).digest('hex') !== sha256) throw new Error(`agent-device ${version} runner does not match its release sha256`);
  const staging = await mkdtemp(path.join(cacheDir(), `.runner-${version}-`));
  try {
    await writeFile(path.join(staging, 'runner.tar.gz'), archive);
    await exec('tar', ['-xzf', 'runner.tar.gz'], { cwd: staging, signal });
    const extracted = (await readdir(staging, { recursive: true })).find((entry) => path.basename(entry) === `agent-device-ios-runner-${version}.app`);
    if (extracted === undefined) throw new Error(`agent-device ${version} runner archive holds no agent-device-ios-runner-${version}.app`);
    await mkdir(path.dirname(app), { recursive: true });
    await rename(path.join(staging, extracted), app).catch(async (error: unknown) => {
      // Another worker put the same runner in place first.
      if (!await stat(app).then(() => true, () => false)) throw error;
    });
    return app;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Off macOS, an Xcode with only the version files agent-device keys its runner cache on. The
 * versions are those of the Xcode the release runner is built with; nothing else reads them.
 */
async function standInXcode(dir: string): Promise<string> {
  const developer = path.join(dir, 'Xcode.app', 'Contents', 'Developer');
  const sdk = path.join(developer, 'Platforms', 'iPhoneSimulator.platform', 'Developer', 'SDKs', 'iPhoneSimulator.sdk');
  const plist = (entries: Record<string, string>) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${Object.entries(entries).map(([key, value]) => `\t<key>${key}</key>\n\t<string>${value}</string>\n`).join('')}</dict>\n</plist>\n`;
  await mkdir(path.join(sdk, 'System', 'Library', 'CoreServices'), { recursive: true });
  await writeFile(path.join(developer, '..', 'version.plist'), plist({ CFBundleShortVersionString: STAND_IN_XCODE.version, ProductBuildVersion: STAND_IN_XCODE.build }));
  await writeFile(path.join(sdk, 'SDKSettings.json'), JSON.stringify({ Version: STAND_IN_XCODE.sdkVersion }));
  await writeFile(path.join(sdk, 'System', 'Library', 'CoreServices', 'SystemVersion.plist'), plist({ ProductBuildVersion: STAND_IN_XCODE.sdkBuild }));
  return developer;
}

const STAND_IN_XCODE = { version: '27.2', build: '27B52', sdkVersion: '27.2', sdkBuild: '24B8118' };

async function download(url: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The app's bundle id, through the lease's plutil shim: the Mac's plutil or libplist. */
async function bundleId(app: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec('plutil', ['-extract', 'CFBundleIdentifier', 'raw', path.join(app, 'Info.plist')], { env });
  return stdout.trim();
}

function cacheDir(): string {
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Caches', 'e2e-argent');
  return path.join(process.env['XDG_CACHE_HOME'] || path.join(homedir(), '.cache'), 'e2e-argent');
}

function definedEnv(env: DeviceRequest['env']): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** No daemon setting from the run may select another daemon, home or connection. */
function withoutAgentDeviceSettings(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key === 'AGENT_DEVICE_DAEMON_POLICY' || !key.startsWith('AGENT_DEVICE_')));
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
