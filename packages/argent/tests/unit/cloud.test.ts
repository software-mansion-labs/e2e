import { describe, expect, it } from 'vitest';
import { pickSimulator, type Simulator } from '../../src/cloud.ts';

const ios = (version: string) => `com.apple.CoreSimulator.SimRuntime.iOS-${version}`;
const device = (name: string, state: string, runtime: string): Simulator => ({ udid: `${name}-${runtime}`, name, state, runtime });

describe('pickSimulator', () => {
  const available = [
    device('iPad Air 11-inch (M3)', 'Booted', ios('26-5')),
    device('iPhone SE (3rd generation)', 'Shutdown', ios('26-5')),
    device('iPhone 17 Pro', 'Shutdown', ios('26-5')),
    device('iPhone 17 Pro', 'Shutdown', ios('26-10')),
  ];

  it('takes a booted iPhone over a shut-down one, and never a booted iPad', () => {
    const booted = [...available, device('iPhone 17 Pro (Slimmed)', 'Booted', ios('26-5'))];
    expect(pickSimulator(booted, undefined)?.name).toBe('iPhone 17 Pro (Slimmed)');
  });

  it('compares runtimes numerically, so iOS 26.10 is newer than 26.5', () => {
    expect(pickSimulator(available, 'iPhone 17 Pro')?.runtime).toBe(ios('26-10'));
  });

  it('finds nothing for a name the machine does not have', () => {
    expect(pickSimulator(available, 'iPhone 99')).toBeUndefined();
  });
});
