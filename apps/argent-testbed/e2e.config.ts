import type { E2EConfig } from 'e2e';
import { argent } from '@e2e-dev/argent';
import { mobile } from '@e2e-dev/mobile';

// Needs ARGENT_CLOUD_API_KEY, sim-remote on PATH, and the app built with `pnpm run build:app`.
export default {
  targets: [
    {
      name: 'ios',
      engine: mobile({ platform: 'ios', device: argent() }),
      app: {
        bundleId: 'dev.e2e.examples.swiftui',
        appPath: 'build/Build/Products/Debug-iphonesimulator/HelloApp.app',
      },
    },
  ],
  workers: 1,
} satisfies E2EConfig;
