import type { API, Logger } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from '../settings.js';

// Homebridge only ships Matter typings from 2.5, but this plugin still installs
// on 2.0 (the Matter API is simply absent there). These structural types cover
// the parts of `api.matter` used here so the build does not depend on them.
export interface MatterAccessory {
  UUID: string;
  displayName: string;
  deviceType: unknown;
  serialNumber: string;
  manufacturer: string;
  model: string;
  firmwareRevision: string;
  context: Record<string, unknown>;
  clusters: Record<string, Record<string, unknown>>;
  handlers: Record<string, Record<string, () => Promise<void>>>;
}

export interface MatterAPI {
  uuid: { generate(data: string): string };
  deviceTypes: { OnOffOutlet: unknown };
  registerPlatformAccessories(plugin: string, platform: string, accessories: MatterAccessory[]): Promise<void>;
  updatePlatformAccessories(accessories: MatterAccessory[]): Promise<void>;
  unregisterPlatformAccessories(plugin: string, platform: string, accessories: { UUID: string }[]): Promise<void>;
  updateAccessoryState(uuid: string, cluster: string, attributes: Record<string, unknown>): Promise<void>;
}

/** `api.matter` when the running Homebridge (2.5+) has Matter enabled for this bridge, otherwise undefined. */
export function matterOf(api: API): MatterAPI | undefined {
  return (api as unknown as { matter?: MatterAPI }).matter;
}

type PowerMeasurement = Partial<Record<'activePower' | 'voltage' | 'activeCurrent', number | null>>;

/** The power/energy fields carried by switch, light, and meter component states (W, V, A, Wh). */
export interface MatterEnergyReading {
  power?: number;
  voltage?: number;
  current?: number;
  energy?: number;
}

export interface MatterEnergyOptions {
  uuid: string;
  displayName: string;
  serialNumber: string;
  model: string;
  firmware?: string;
  on?: boolean;
  /** Turns the relay/light on or off; absent for a read-only meter channel, whose on/off just follows its power draw. */
  setOn?: (on: boolean) => Promise<void>;
}

// Energy totals are delivered to controllers as unthrottled Matter events, so
// they are reported at a measured cadence rather than on every poll or push.
export const ENERGY_REPORT_INTERVAL_MS = 30_000;

const NO_POWER: PowerMeasurement = { activePower: null, voltage: null, activeCurrent: null };

/** Converts watts, volts, and amps to the milli-units used by Matter ElectricalPowerMeasurement. */
export function toMatterPowerMeasurement(reading: MatterEnergyReading): PowerMeasurement {
  const measurement: PowerMeasurement = {};
  if (reading.power !== undefined) measurement.activePower = Math.round(reading.power * 1_000);
  if (reading.voltage !== undefined) measurement.voltage = Math.round(reading.voltage * 1_000);
  if (reading.current !== undefined) measurement.activeCurrent = Math.round(reading.current * 1_000);
  return measurement;
}

/** Converts watt-hours to the milliwatt-hours used by Matter ElectricalEnergyMeasurement. */
export function toMatterEnergy(energyWh: number): number {
  return Math.round(energyWh * 1_000);
}

/** Whether a reading has anything Matter can report. */
export function hasMatterEnergy(reading: MatterEnergyReading): boolean {
  return reading.power !== undefined || reading.voltage !== undefined || reading.current !== undefined
    || reading.energy !== undefined;
}

export function matterEnergyUuid(matter: MatterAPI, baseId: string, componentKey: string): string {
  return matter.uuid.generate(`shelly:${baseId}:${componentKey}:matter-outlet`);
}

/**
 * Exposes one metered Shelly component to Matter as an On/Off Outlet reporting
 * power, voltage, current, and imported energy, so controllers that read Matter
 * 1.3 energy metrics (Apple Home on iOS 27) can show them. HAP stays the primary
 * integration; this is an additional, best-effort view of the same component.
 */
export class ShellyMatterEnergy {
  readonly accessory: MatterAccessory;
  private online = true;
  private reportedEnergy?: number;
  private energyReportedAt = 0;
  private registration: Promise<boolean> = Promise.resolve(false);

  constructor(
    private readonly matter: MatterAPI,
    private readonly log: Logger,
    options: MatterEnergyOptions,
  ) {
    const handleOnOff = async (on: boolean): Promise<void> => {
      this.log.info(`Turning ${on ? 'on' : 'off'} ${options.displayName} (Matter)`);
      await options.setOn?.(on);
    };

    this.accessory = {
      UUID: options.uuid,
      displayName: options.displayName,
      deviceType: matter.deviceTypes.OnOffOutlet,
      serialNumber: options.serialNumber.slice(0, 32),
      manufacturer: 'Shelly',
      model: options.model.slice(0, 32),
      firmwareRevision: options.firmware ?? 'unknown',
      context: {},
      clusters: {
        onOff: { onOff: options.on ?? false },
        // null means "no measurement available"; declaring the attributes is
        // what makes Homebridge compose the AC power and imported cumulative
        // energy features onto the outlet endpoint.
        electricalPowerMeasurement: { activePower: null, voltage: null, activeCurrent: null },
        electricalEnergyMeasurement: { cumulativeEnergyImported: null },
      },
      handlers: { onOff: { on: () => handleOnOff(true), off: () => handleOnOff(false) } },
    };
  }

  /** Registers (or re-attaches to a cached) Matter accessory; state updates queue behind it. */
  register(): Promise<void> {
    this.registration = this.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [this.accessory])
      .then(() => true, error => {
        this.logError('registration', error);
        return false;
      });
    return this.registration.then(() => undefined);
  }

  rename(displayName: string): void {
    if (this.accessory.displayName === displayName) return;
    this.accessory.displayName = displayName;
    this.whenRegistered('rename', () => this.matter.updatePlatformAccessories([this.accessory]));
  }

  /** Pushes the component's current state; energy totals are throttled to ENERGY_REPORT_INTERVAL_MS. */
  update(reading: MatterEnergyReading, on: boolean, now = Date.now()): void {
    this.setState('onOff', { onOff: on });
    if (!this.online) return;

    const power = toMatterPowerMeasurement(reading);
    if (Object.keys(power).length > 0) this.setState('electricalPowerMeasurement', power);

    if (reading.energy !== undefined) {
      const energy = toMatterEnergy(reading.energy);
      const due = now - this.energyReportedAt >= ENERGY_REPORT_INTERVAL_MS;
      if (energy !== this.reportedEnergy && (this.reportedEnergy === undefined || due)) {
        this.reportedEnergy = energy;
        this.energyReportedAt = now;
        this.setState('electricalEnergyMeasurement', { cumulativeEnergyImported: { energy } });
      }
    }
  }

  /** Marks the bridged device unreachable and clears live readings, or restores reachability. */
  setReachable(reachable: boolean): void {
    if (this.online === reachable) return;
    this.online = reachable;
    this.setState('bridgedDeviceBasicInformation', { reachable });
    if (!reachable) this.setState('electricalPowerMeasurement', NO_POWER);
  }

  private setState(cluster: string, attributes: Record<string, unknown>): void {
    this.whenRegistered(
      `update ${cluster}`,
      () => this.matter.updateAccessoryState(this.accessory.UUID, cluster, attributes),
    );
  }

  private whenRegistered(action: string, run: () => Promise<void>): void {
    this.registration
      .then(registered => registered ? run() : undefined)
      .catch(error => this.logError(action, error));
  }

  private logError(action: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log.warn(`Matter ${action} failed for ${this.accessory.displayName}: ${message}`);
  }
}
