import { createAgentDeviceClient } from 'agent-device';

/** Starts the daemon in `stateDir` from this process, so it inherits this process's environment: the shims on PATH and the sim-remote session. */
export interface DriverRequest {
  readonly stateDir: string;
  readonly udid: string;
}

process.once('message', (request: DriverRequest) => {
  void start(request).then(
    () => process.send?.({ ok: true }, () => process.disconnect?.()),
    (cause: unknown) => process.send?.({ error: describe(cause) }, () => process.disconnect?.()),
  );
});

/** The message, with agent-device's failure reason when it gives one. */
function describe(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const details = 'details' in cause && typeof cause.details === 'object' && cause.details !== null ? cause.details as Record<string, unknown> : {};
  const extra = ['reason', 'startError', 'startupError', 'hint'].flatMap((key) => (details[key] === undefined ? [] : [`${key}: ${typeof details[key] === 'string' ? details[key] : JSON.stringify(details[key])}`]));
  return extra.length === 0 ? cause.message : `${cause.message} (${extra.join('; ')})`;
}

async function start({ stateDir, udid }: DriverRequest): Promise<void> {
  const client = createAgentDeviceClient({ stateDir, daemonBaseUrl: '', daemonAuthToken: '', daemonTransport: 'auto' });
  const devices = await client.devices.list({ platform: 'ios' });
  if (!devices.some((device) => device.id === udid)) {
    throw new Error(`agent-device does not list Argent Cloud simulator ${udid}; it lists ${devices.map((device) => device.id).join(', ') || 'nothing'}`);
  }
}
