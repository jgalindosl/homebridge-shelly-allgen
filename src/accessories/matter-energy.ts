import type { ClusterStateMap, Logger, MatterAPI, MatterAccessory } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from '../settings.js';

type PowerMeasurement = Partial<ClusterStateMap['electricalPowerMeasurement']>;

/** The power/energy fields carried by switch, light, and meter component states (W, V, A, Wh). */
export interface MatterEnergyReading {
  power?: number;
  voltage?: number;
  current?: number;
  energy?: number;
  energyReturned?: number;
}

/** What a Shelly component becomes in Matter: a controllable outlet, or a standalone meter. */
export type MatterEnergyKind = 'outlet' | 'meter';

export interface MatterEnergyOptions {
  uuid: string;
  displayName: string;
  kind: MatterEnergyKind;
  serialNumber: string;
  model: string;
  firmware?: string;
  /** Initial readings; their shape decides which measurement attributes the endpoint declares. */
  reading: MatterEnergyReading;
  on?: boolean;
  /** Turns the relay/light on or off; absent for a meter. */
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
    || reading.energy !== undefined || reading.energyReturned !== undefined;
}

export function matterEnergyUuid(matter: MatterAPI, baseId: string, componentKey: string): string {
  return matter.uuid.generate(`shelly:${baseId}:${componentKey}:matter`);
}

/**
 * Exposes one metered Shelly component to Matter so controllers that read
 * Matter 1.3 energy metrics (Apple Home on iOS 27) can show live power and
 * energy. Relays and lights become an outlet, and EM channels a standalone
 * Electrical Sensor. HAP stays the primary integration; this is an
 * additional, best-effort view of the same component.
 */
export class ShellyMatterEnergy {
  readonly accessory: MatterAccessory<{ componentKey?: string }>;
  private online = true;
  private reportedEnergy?: number;
  private reportedExported?: number;
  private energyReportedAt = 0;
  private registration: Promise<boolean> = Promise.resolve(false);
  private readonly declared: { power: boolean; energy: boolean; exported: boolean };

  constructor(
    private readonly matter: MatterAPI,
    private readonly log: Logger,
    options: MatterEnergyOptions,
  ) {
    const { reading } = options;
    const hasPower = reading.power !== undefined || reading.voltage !== undefined || reading.current !== undefined;
    this.declared = { power: hasPower, energy: reading.energy !== undefined, exported: reading.energyReturned !== undefined };

    // A null attribute means "no measurement available"; declaring it is what
    // makes Homebridge compose the matching feature onto the endpoint.
    const clusters: Record<string, Record<string, unknown>> = {};
    if (options.kind !== 'meter') clusters.onOff = { onOff: options.on ?? false };
    if (hasPower) {
      clusters.electricalPowerMeasurement = {
        activePower: null,
        ...(reading.voltage !== undefined ? { voltage: null } : {}),
        ...(reading.current !== undefined ? { activeCurrent: null } : {}),
      };
    }
    if (this.declared.energy || this.declared.exported) {
      clusters.electricalEnergyMeasurement = {
        ...(this.declared.energy ? { cumulativeEnergyImported: null } : {}),
        ...(this.declared.exported ? { cumulativeEnergyExported: null } : {}),
      };
    }

    const deviceType = options.kind === 'outlet' ? matter.deviceTypes.OnOffOutlet : matter.deviceTypes.ElectricalSensor;
    const handle = async (on: boolean): Promise<void> => {
      this.log.info(`Turning ${on ? 'on' : 'off'} ${options.displayName} (Matter)`);
      await options.setOn?.(on);
    };

    this.accessory = {
      UUID: options.uuid,
      displayName: options.displayName,
      deviceType,
      serialNumber: options.serialNumber,
      manufacturer: 'Shelly',
      model: options.model,
      firmwareRevision: options.firmware ?? 'unknown',
      context: {},
      clusters,
      handlers: options.kind === 'meter' ? {} : { onOff: { on: () => handle(true), off: () => handle(false) } },
    } as MatterAccessory<{ componentKey?: string }>;
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
  update(reading: MatterEnergyReading, on?: boolean, now = Date.now()): void {
    if (on !== undefined && this.accessory.clusters?.onOff) this.setState('onOff', { onOff: on });
    if (!this.online) return;

    if (this.declared.power) {
      const power = toMatterPowerMeasurement(reading);
      if (Object.keys(power).length > 0) this.setState('electricalPowerMeasurement', power);
    }

    const energy = reading.energy !== undefined ? toMatterEnergy(reading.energy) : undefined;
    const exported = reading.energyReturned !== undefined ? toMatterEnergy(reading.energyReturned) : undefined;
    const changed = (this.declared.energy && energy !== undefined && energy !== this.reportedEnergy)
      || (this.declared.exported && exported !== undefined && exported !== this.reportedExported);
    const first = this.energyReportedAt === 0;
    if (changed && (first || now - this.energyReportedAt >= ENERGY_REPORT_INTERVAL_MS)) {
      this.energyReportedAt = now;
      const attributes: Record<string, unknown> = {};
      if (this.declared.energy && energy !== undefined) {
        this.reportedEnergy = energy;
        attributes.cumulativeEnergyImported = { energy };
      }
      if (this.declared.exported && exported !== undefined) {
        this.reportedExported = exported;
        attributes.cumulativeEnergyExported = { energy: exported };
      }
      this.setState('electricalEnergyMeasurement', attributes);
    }
  }

  /** Marks the bridged device unreachable and clears live readings, or restores reachability. */
  setReachable(reachable: boolean): void {
    if (this.online === reachable) return;
    this.online = reachable;
    this.setState('bridgedDeviceBasicInformation', { reachable });
    if (!reachable && this.declared.power) this.setState('electricalPowerMeasurement', this.clearedPower());
  }

  private clearedPower(): PowerMeasurement {
    const cluster = this.accessory.clusters?.electricalPowerMeasurement as PowerMeasurement | undefined;
    return Object.fromEntries(Object.keys(cluster ?? NO_POWER).map(key => [key, null])) as PowerMeasurement;
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
