'use strict';

const ModbusRTU = require('modbus-serial');
const { SimulatorDevice, waitForServer } = require('./simulator-device');
const { EM500_PROFILE } = require('../seed/em500.profile');
const { HUAWEI_SUN2000_PROFILE } = require('../seed/huawei-sun2000.profile');
const { SOLIS_PROFILE } = require('../seed/solis-inverter.profile');
const { SUNGROW_PROFILE } = require('../seed/sungrow-inverter.profile');
const { EXTENDED_INVERTER_PROFILES } = require('../seed/extended-inverter-profiles');

const MODBUS_TCP_PORT = 502;
const LEGACY_DEFAULT_PORTS = Object.freeze({
  em500: 15020,
  huawei: 15021,
  solis: 15022,
  sungrow: 15023,
});

/**
 * Simulator farm: one or more Modbus TCP slaves.
 *
 * Devices that share the same host:port are served by ONE shared TCP server
 * and are distinguished by unit ID — exactly like an RS485 bus bridged over
 * TCP. All built-in devices share the standard Modbus TCP port 502 and are
 * distinguished by unique unit IDs: EM500 meter (unit 1), Huawei SUN2000
 * inverter (unit 2), Solis inverter (unit 3), and Sungrow inverter (unit 4).
 */
const baseSimulatorDevices = {
  em500: new SimulatorDevice({
    key: 'em500',
    deviceType: 'EM500 meter',
    profile: EM500_PROFILE,
    defaultConfiguration: {
      host: '0.0.0.0',
      port: MODBUS_TCP_PORT,
      unitId: 1,
      updateIntervalMs: 1000,
      options: {
        loadKw: 100,
      },
    },
  }),
  huawei: new SimulatorDevice({
    key: 'huawei',
    deviceType: 'Huawei SUN2000 inverter',
    profile: HUAWEI_SUN2000_PROFILE,
    defaultConfiguration: {
      host: '0.0.0.0',
      port: MODBUS_TCP_PORT,
      unitId: 2,
      updateIntervalMs: 1000,
      options: {
        ratingKw: 100,
        availabilityPct: 80,
        loadKw: 100,
      },
    },
  }),
  solis: new SimulatorDevice({
    key: 'solis',
    deviceType: 'Solis inverter',
    profile: SOLIS_PROFILE,
    defaultConfiguration: {
      host: '0.0.0.0',
      port: MODBUS_TCP_PORT,
      unitId: 3,
      updateIntervalMs: 1000,
      options: {
        ratingKw: 100,
        availabilityPct: 80,
        loadKw: 100,
      },
    },
  }),
  sungrow: new SimulatorDevice({
    key: 'sungrow',
    deviceType: 'Sungrow inverter',
    profile: SUNGROW_PROFILE,
    defaultConfiguration: {
      host: '0.0.0.0',
      port: MODBUS_TCP_PORT,
      unitId: 4,
      updateIntervalMs: 1000,
      options: {
        ratingKw: 100,
        availabilityPct: 80,
        loadKw: 100,
      },
    },
  }),
};

const extendedSimulatorDevices = Object.fromEntries(
  EXTENDED_INVERTER_PROFILES.map((profile, index) => {
    const key = profile.identifier.split('-')[0];
    const ratingKw = Number(profile.metadata?.simulator?.ratingKw) || 100;
    return [key, new SimulatorDevice({
      key,
      deviceType: profile.name,
      profile,
      defaultConfiguration: {
        host: '0.0.0.0',
        port: MODBUS_TCP_PORT,
        unitId: index + 5,
        updateIntervalMs: 1000,
        options: {
          ratingKw,
          availabilityPct: 80,
          loadKw: 100,
          zeroFillGaps: false,
        },
      },
    })];
  }),
);

const simulatorDevices = Object.freeze({
  ...baseSimulatorDevices,
  ...extendedSimulatorDevices,
});

const START_ORDER = Object.freeze([
  'huawei', 'solis', 'sungrow',
  'sofar', 'growatt', 'deye', 'foxess', 'goodwe', 'esinv',
  'em500',
]);

// host:port -> { server, devices: Set }
const sharedServers = new Map();

function getDevice(key) {
  return simulatorDevices[key] || null;
}

function orderedDevices() {
  const ordered = START_ORDER.map((key) => simulatorDevices[key]).filter(Boolean);
  const included = new Set(ordered);
  return ordered.concat(Object.values(simulatorDevices).filter((device) => !included.has(device)));
}

function portKeyOf(device) {
  const status = device.getStatus();
  return `${status.host}:${status.port}`;
}

function modbusError(message, modbusErrorCode = 0x04) {
  const error = new Error(message);
  error.modbusErrorCode = modbusErrorCode;
  return error;
}

/** Build a server vector that dispatches every request to the device whose
 *  configured unit ID matches the request, like a shared RS485 bus. */
function buildSharedVector(devices) {
  const byUnit = new Map(devices.map((device) => [device.configuration.unitId, device]));

  const call = (fnName, args) => {
    const unitId = args[args.length - 1];
    const device = byUnit.get(unitId) || (unitId === 0 ? devices[0] : undefined);
    if (!device || device.getStatus().state !== 'RUNNING') {
      throw modbusError(`No running simulated device on unit ${unitId}.`, 0x0b);
    }
    return device.createVector()[fnName](...args);
  };

  return {
    getCoil: (...args) => call('getCoil', args),
    getDiscreteInput: (...args) => call('getDiscreteInput', args),
    getHoldingRegister: (...args) => call('getHoldingRegister', args),
    getInputRegister: (...args) => call('getInputRegister', args),
    getMultipleHoldingRegisters: (...args) => call('getMultipleHoldingRegisters', args),
    getMultipleInputRegisters: (...args) => call('getMultipleInputRegisters', args),
    setCoil: (...args) => call('setCoil', args),
    setRegister: (...args) => call('setRegister', args),
    setRegisterArray: (...args) => call('setRegisterArray', args),
    readDeviceIdentification: () => devices[0]?.createVector().readDeviceIdentification(),
  };
}

function closeSharedServer(key) {
  const entry = sharedServers.get(key);
  if (!entry) return Promise.resolve();
  sharedServers.delete(key);
  return new Promise((resolve) => {
    try {
      entry.server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

/** Start one shared TCP server for a group of devices on the same host:port. */
async function startSharedGroup(devices) {
  if (devices.length === 0) return;

  // Release any self-owned servers first.
  await Promise.all(devices.map((device) => device.stop()));

  const key = portKeyOf(devices[0]);

  // Unit IDs must be unique within a shared port.
  const units = new Set();
  for (const device of devices) {
    const unitId = device.configuration.unitId;
    if (units.has(unitId)) {
      throw new Error(
        `Duplicate unit ID ${unitId} on shared port ${key}. Use different unit IDs on the same port.`,
      );
    }
    units.add(unitId);
  }

  await closeSharedServer(key);

  const vector = buildSharedVector(devices);
  const server = new ModbusRTU.ServerTCP(vector, {
    host: devices[0].configuration.host,
    port: devices[0].configuration.port,
    unitID: 255, // respond to every unit ID; the vector dispatches
  });
  try {
    await waitForServer(server);
  } catch (error) {
    const port = devices[0].configuration.port;
    if (error?.code === 'EACCES' && port < 1024) {
      error.message = `Permission denied binding privileged Modbus TCP port ${port}. On Linux grant CAP_NET_BIND_SERVICE to the Node service; do not run the simulator as root.`;
    } else if (error?.code === 'EADDRINUSE') {
      error.message = `Modbus TCP endpoint ${devices[0].configuration.host}:${port} is already in use.`;
    }
    throw error;
  }

  const attached = new Set();
  sharedServers.set(key, { server, devices: attached });
  for (const device of devices) {
    device.attachSharedServer(server);
    attached.add(device);
  }
}

/** Group every farm device by host:port and start one shared server per port. */
async function startAll() {
  const groups = new Map();
  // Preserve inverter-before-meter order inside each shared host:port group.
  for (const device of orderedDevices()) {
    const groupKey = portKeyOf(device);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(device);
  }
  for (const group of groups.values()) {
    await startSharedGroup(group);
  }
  return getStatus();
}

async function stopAll() {
  // Stop ticks for every device, then close the shared servers.
  await Promise.all(Object.values(simulatorDevices).map((device) => device.stop()));
  await Promise.all([...sharedServers.keys()].map((key) => closeSharedServer(key)));
  return getStatus();
}

/** Start the shared server of the port group this device belongs to. */
async function startDevice(key) {
  const device = getDevice(key);
  if (!device) return getStatus();
  const groupKey = portKeyOf(device);
  const group = orderedDevices().filter(
    (candidate) => portKeyOf(candidate) === groupKey,
  );
  await startSharedGroup(group);
  return getStatus();
}

/** Stop one device; the shared server stays up while other devices on the
 *  same port are still running and closes when the last one stops. */
async function stopDevice(key) {
  const device = getDevice(key);
  if (!device) return getStatus();
  const groupKey = portKeyOf(device);
  await device.stop();
  const entry = sharedServers.get(groupKey);
  if (entry) {
    entry.devices.delete(device);
    const stillRunning = [...entry.devices].some(
      (candidate) => candidate.getStatus().state === 'RUNNING',
    );
    if (!stillRunning) {
      await closeSharedServer(groupKey);
    }
  }
  return getStatus();
}

/** Apply persisted settings (port, unit ID, options) to every device. */
async function applyPersistedSettings(settingsRepository, deviceRepository) {
  const results = [];
  for (const key of Object.keys(simulatorDevices)) {
    let applied = false;
    let migratedPort = false;
    let linkedDeviceSynced = false;
    let errorMessage = null;

    try {
      const saved = await settingsRepository.get(key);
      if (saved) {
        const { key: ignoredKey, createdAt, updatedAt, _id, ...settings } = saved;
        void ignoredKey; void createdAt; void updatedAt; void _id;

        // Migrate only the four old built-in defaults. Operator-selected ports
        // are preserved, while old linked EMS records are synchronized below.
        if (settings.port === LEGACY_DEFAULT_PORTS[key]) {
          settings.port = MODBUS_TCP_PORT;
          migratedPort = true;
        }

        simulatorDevices[key].configure(settings);
        applied = true;

        if (migratedPort) {
          await settingsRepository.save(key, settings);
        }
      }
    } catch (error) {
      errorMessage = error.message;
    }

    // Keep the EMS polling records on the same port/unit ID as their simulator.
    // This also fixes existing installations that have no saved simulator
    // settings but still have linked device records using the old ports.
    if (deviceRepository) {
      try {
        const status = simulatorDevices[key].getStatus();
        const linked = await deviceRepository.findOne({
          identifier: `${key}-simulator`,
        });
        if (linked) {
          const patch = {};
          if (linked.unitId !== status.unitId) {
            patch.unitId = status.unitId;
          }
          if (linked.connection?.port !== status.port) {
            patch.connection = {
              protocol: linked.connection?.protocol || 'TCP',
              host: linked.connection?.host || '127.0.0.1',
              port: status.port,
            };
          }
          if (Object.keys(patch).length > 0) {
            await deviceRepository.updateById(linked._id, patch);
            linkedDeviceSynced = true;
          }
        }
      } catch (error) {
        errorMessage = errorMessage
          ? `${errorMessage}; linked device sync: ${error.message}`
          : `linked device sync: ${error.message}`;
      }
    }

    results.push({
      key,
      applied,
      ...(migratedPort ? { migratedPort: true } : {}),
      ...(linkedDeviceSynced ? { linkedDeviceSynced: true } : {}),
      ...(errorMessage ? { error: errorMessage } : {}),
    });
  }
  return results;
}

function getStatus() {
  const devices = {};
  for (const [key, device] of Object.entries(simulatorDevices)) {
    devices[key] = device.getStatus();
  }
  return { devices };
}

function getValues(key) {
  const device = getDevice(key);
  if (!device) return [];
  // A stopped simulator must not report stale values: every consumer (the
  // simulator page, the zero-export power flow) treats an empty list as
  // "device not producing".
  if (device.getStatus().state !== 'RUNNING') return [];
  return device.getValues();
}

module.exports = {
  applyPersistedSettings,
  buildSharedVector,
  getDevice,
  getStatus,
  getValues,
  sharedServers,
  simulatorDevices,
  startAll,
  startDevice,
  stopAll,
  stopDevice,
};
