// Preloaded through NODE_OPTIONS into the agent-device daemon of an Argent
// lease, the way `sim-remote install-shims` preloads Appium on Linux.
//
// agent-device refuses iOS simulators unless `process.platform` is 'darwin',
// on the assumption that only a Mac has simctl and xcodebuild. In a lease the
// xcrun, xcodebuild and plutil on PATH are shims that answer for the cloud
// Mac, so agent-device is told it runs on one: its daemon, and the clients
// that start and stop it (the lease's driver and agent-device's CLI), which
// must agree with the daemon on how a process is identified. Every other node
// process started with this environment keeps seeing the truth.
'use strict';

const main = process.argv[1] || '';
const agentDevice = /[\\/]agent-device[\\/](?:dist|bin)[\\/]/.test(main);
const driver = /[\\/]argent[\\/](?:dist|src)[\\/]driver\.[jt]s$/.test(main);
if (process.platform !== 'darwin' && (agentDevice || driver)) {
  Object.defineProperty(process, 'platform', { value: 'darwin', writable: false, enumerable: true, configurable: true });
}
