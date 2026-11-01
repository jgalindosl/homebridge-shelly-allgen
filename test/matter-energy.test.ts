import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { API, Logger, MatterAPI } from 'homebridge';
import { ENERGY_REPORT_INTERVAL_MS, ShellyMatterEnergy, toMatterEnergy, toMatterPowerMeasurement } from '../src/accessories/matter-energy.js';
import type { ShellyComponent } from '../src/shelly/types.js';
import { createAccessory, fakePlatform } from './helpers/accessory.js';

function fakeMatter() {
  return {
    uuid: { generate: (s: string) => `uuid:${s}` },
    deviceTypes: { OnOffOutlet: 'outlet', OnOffLight: 'light', ElectricalSensor: 'sensor' },
    registerPlatformAccessories: vi.fn(async () => {}),
    updatePlatformAccessories: vi.fn(async () => {}),
    updateAccessoryState: vi.fn(async () => {}),
  };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('unit conversion', () => {
  it('converts W/V/A to milli-units and Wh to mWh', () => {
    expect(toMatterPowerMeasurement({ power: 12.3456, voltage: 230.1, current: 0.054 }))
      .toEqual({ activePower: 12346, voltage: 230100, activeCurrent: 54 });
    expect(toMatterPowerMeasurement({ energy: 5 })).toEqual({});
    expect(toMatterEnergy(1.5)).toBe(1500);
  });
});

describe('ShellyMatterEnergy', () => {
  const base = { uuid: 'u1', displayName: 'Plug', serialNumber: 'AA:relay:0', model: 'SNPL-00112EU' };

  it('declares only the measurements the component reports', () => {
    const matter = fakeMatter();
    const e = new ShellyMatterEnergy(matter as unknown as MatterAPI, log, { ...base, kind: 'outlet', reading: { power: 1, energy: 2 } });
    expect(e.accessory.deviceType).toBe('outlet');
    expect(e.accessory.clusters).toEqual({
      onOff: { onOff: false },
      electricalPowerMeasurement: { activePower: null },
      electricalEnergyMeasurement: { cumulativeEnergyImported: null },
    });
  });

  it('exposes a meter as an electrical sensor with exported energy and no on/off', () => {
    const matter = fakeMatter();
    const e = new ShellyMatterEnergy(matter as unknown as MatterAPI, log, {
      ...base, kind: 'meter', reading: { power: 1, voltage: 230, current: 1, energy: 2, energyReturned: 3 },
    });
    expect(e.accessory.deviceType).toBe('sensor');
    expect(e.accessory.clusters).toEqual({
      electricalPowerMeasurement: { activePower: null, voltage: null, activeCurrent: null },
      electricalEnergyMeasurement: { cumulativeEnergyImported: null, cumulativeEnergyExported: null },
    });
    expect(e.accessory.handlers).toEqual({});
  });

  it('throttles energy totals but not power', async () => {
    const matter = fakeMatter();
    const e = new ShellyMatterEnergy(matter as unknown as MatterAPI, log, { ...base, kind: 'outlet', reading: { power: 1, energy: 1 } });
    await e.register();
    e.update({ power: 5, energy: 1 }, true, 1_000);
    e.update({ power: 6, energy: 2 }, true, 2_000);
    e.update({ power: 7, energy: 3 }, true, 1_000 + ENERGY_REPORT_INTERVAL_MS);
    await flush();
    const calls = matter.updateAccessoryState.mock.calls.map(c => [c[1], c[2]]);
    expect(calls.filter(c => c[0] === 'electricalPowerMeasurement')).toHaveLength(3);
    expect(calls.filter(c => c[0] === 'electricalEnergyMeasurement')).toEqual([
      ['electricalEnergyMeasurement', { cumulativeEnergyImported: { energy: 1000 } }],
      ['electricalEnergyMeasurement', { cumulativeEnergyImported: { energy: 3000 } }],
    ]);
  });

  it('marks unreachable and clears power, then restores', async () => {
    const matter = fakeMatter();
    const e = new ShellyMatterEnergy(matter as unknown as MatterAPI, log, { ...base, kind: 'outlet', reading: { power: 1, voltage: 230 } });
    await e.register();
    e.setReachable(false);
    e.setReachable(true);
    await flush();
    expect(matter.updateAccessoryState.mock.calls.map(c => [c[1], c[2]])).toEqual([
      ['bridgedDeviceBasicInformation', { reachable: false }],
      ['electricalPowerMeasurement', { activePower: null, voltage: null }],
      ['bridgedDeviceBasicInformation', { reachable: true }],
    ]);
  });

  it('skips state updates when registration failed', async () => {
    const matter = fakeMatter();
    matter.registerPlatformAccessories.mockRejectedValueOnce(new Error('nope'));
    const e = new ShellyMatterEnergy(matter as unknown as MatterAPI, log, { ...base, kind: 'outlet', reading: { power: 1 } });
    await e.register();
    e.update({ power: 2 }, true);
    await flush();
    expect(matter.updateAccessoryState).not.toHaveBeenCalled();
  });
});

describe('ShellyDeviceAccessory Matter mirroring', () => {
  const relay: ShellyComponent = { key: 'relay:0', type: 'switch', id: 0, state: { on: false, power: 10, energy: 100 } };
  const dry: ShellyComponent = { key: 'relay:1', type: 'switch', id: 1, state: { on: false } };

  function withMatter(components: ShellyComponent[]) {
    const matter = fakeMatter();
    const platform = fakePlatform();
    (platform.api as { matter?: unknown }).matter = matter;
    const claimed: string[] = [];
    (platform as unknown as { claimMatterAccessory: (u: string) => void }).claimMatterAccessory = u => { claimed.push(u); };
    const result = createAccessory({ components, platform, device: { model: 'SNPL-00112EU' } });
    return { matter, claimed, ...result };
  }

  it('registers only components that report energy, and claims them', async () => {
    const { matter, claimed, handler } = withMatter([relay, dry]);
    await flush();
    expect(matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    expect(claimed).toEqual(['uuid:shelly:AABBCCDDEEFF:relay:0:matter']);
    handler.close();
  });

  it('relays Matter on/off to the device and pushes the new state', async () => {
    const { matter, client, handler } = withMatter([relay]);
    const accessory = (matter.registerPlatformAccessories.mock.calls[0] as unknown[])[2] as { handlers: { onOff: { on: () => Promise<void> } } }[];
    await accessory[0].handlers.onOff.on();
    expect(client.setSwitch).toHaveBeenCalledWith(0, true);
    await flush();
    expect(matter.updateAccessoryState).toHaveBeenCalledWith('uuid:shelly:AABBCCDDEEFF:relay:0:matter', 'onOff', { onOff: true });
    handler.close();
  });

  it('does nothing when Matter is not enabled', () => {
    const { handler } = createAccessory({ components: [relay] });
    handler.close();
  });
});
