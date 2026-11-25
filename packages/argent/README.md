# @e2e-dev/argent

Run `@e2e-dev/mobile` tests on [Argent Cloud](https://argent.swmansion.com) iOS simulators.
Each worker gets its own cloud machine and simulator, and the build is installed on it.

```ts
import { mobile } from '@e2e-dev/mobile';
import { argent } from '@e2e-dev/argent';

const engine = mobile({ platform: 'ios', device: argent() });
```

Set `ARGENT_CLOUD_API_KEY` in the run environment and put
[`sim-remote`](https://github.com/software-mansion/sim-remote-releases/releases/latest) on
`PATH` (or set `SIM_REMOTE_BIN`). The provider runs on macOS and Linux and needs no Xcode.
On Linux it also needs libplist's `plistutil` 2.3 or newer, as Argent Cloud's Maestro
support does. Ubuntu 24.04's `libplist-utils` package has it; Ubuntu 22.04 and Debian 12
ship 2.2.0, which is too old.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `device` | a booted iPhone, else the first iPhone on the newest iOS | Simulator to lease, by name, such as `'iPhone 17 Pro'`. |
| `acquireTimeout` | `600` | Seconds to wait for a free machine. |
| `reversePorts` | none | Local ports the simulator reaches, such as Metro's `8081`. |
| `simRemote` | `SIM_REMOTE_BIN`, then `sim-remote` | The `sim-remote` executable. |

`ARGENT_CLOUD_URL` overrides the router URL built into `sim-remote`.

## How it works

The provider uses the same mechanism Argent Cloud uses for Maestro and Appium: tools
that shell out to `xcrun simctl` and `xcodebuild` are pointed at shims that run those
commands on the cloud machine.

For each worker slot, `acquire`:

1. logs in a separate `sim-remote` session, which acquires a machine;
2. picks and boots a simulator on it;
3. starts an agent-device daemon whose `PATH` starts with this package's `xcrun`,
   `xcodebuild` and `plutil` shims, and returns the daemon's state directory and the
   simulator's UDID as the lease.

The `xcrun` shim sends `simctl` to the cloud through `sim-remote`. The `plutil` shim is
the Mac's own plutil, or libplist elsewhere.

agent-device's runner is not built. The provider downloads agent-device's own prebuilt
runner from its GitHub release, checks it against the release's sha256, and caches it.
When agent-device runs `build-for-testing`, the `xcodebuild` shim puts that runner where
the build would have. When agent-device starts the runner with `test-without-building`,
the shim does the following instead:

1. installs the runner on the cloud simulator;
2. stages an XCTest configuration on the machine;
3. launches the runner on a remote port;
4. forwards agent-device's local port to that remote port.

`release` stops the daemon and logs out, which releases the machine.

### Linux

agent-device drives iOS simulators only when `process.platform` is `'darwin'`. A preload
(`shims/agent-device-host.cjs`, added through `NODE_OPTIONS`) tells agent-device's
daemon and CLI, and this package's driver, that they run on macOS. `sim-remote`
preloads Appium the same way. Off macOS the provider also writes a stand-in Xcode
that holds only the version files agent-device keys its runner cache on, and points
`DEVELOPER_DIR` at it.

This relies on agent-device internals, so pin the agent-device version this package
was tested with.
