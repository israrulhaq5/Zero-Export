'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRegisterProfileBodySchema } = require('../src/validators/register-profile.validator');
const { EXTENDED_INVERTER_PROFILES } = require('../src/seed/extended-inverter-profiles');
const { BUILTIN_PROFILES, seedBuiltinProfiles } = require('../src/seed/builtin-profiles');
const { buildSharedVector, simulatorDevices } = require('../src/simulator');
const { encodeRegister } = require('../src/modbus/register-encoder');

const EXTENDED_KEYS = ['sofar', 'growatt', 'deye', 'foxess', 'goodwe', 'esinv'];

function restoreDevice(device) {
  device.state = 'STOPPED';
  device.startedAt = null;
  device.model = device.createModel();
  device.memory.clear();
  device.values.clear();
  device.controlValues.clear();
  device.tickCount = 0;
  device.lastTickAt = null;
  device.lastRequestAt = null;
}

test('six extended inverter profiles are valid, unique and included in built-ins', () => {
  assert.equal(EXTENDED_INVERTER_PROFILES.length, 6);
  assert.equal(BUILTIN_PROFILES.length, 10);

  for (const profile of EXTENDED_INVERTER_PROFILES) {
    const parsed = createRegisterProfileBodySchema.parse(profile);
    assert.ok(parsed.registers.length > 0);
    assert.equal(parsed.registers.length, profile.metadata.registerCount);
    assert.equal(new Set(parsed.registers.map((register) => register.key)).size, parsed.registers.length);
    assert.ok(BUILTIN_PROFILES.some((item) => item.identifier === profile.identifier));

    const occupied = new Map();
    for (const register of parsed.registers.filter((item) => item.enabled !== false)) {
      const length = register.length || 1;
      for (let offset = 0; offset < length; offset += 1) {
        const addressKey = register.registerType + ':' + (register.address + offset);
        assert.ok(
          !occupied.has(addressKey),
          profile.identifier + ' has overlapping active register ranges at ' + addressKey
            + ' (' + occupied.get(addressKey) + ' / ' + register.key + ')',
        );
        occupied.set(addressKey, register.key);
      }
    }

    assert.ok(profile.metadata.source);
    assert.match(profile.metadata.sourceUrl, /^https:\/\/(?:drive|docs)\.google\.com\//);
    assert.equal(profile.metadata.profileVersion, 2);
    assert.equal(profile.metadata.simulator.genericInverter, true);
    assert.ok(profile.metadata.simulator.ratingKw > 0);
  }

  const foxess = EXTENDED_INVERTER_PROFILES.find((profile) => profile.identifier === 'foxess-r-v-h3plus');
  const sunSpecId = foxess.registers.find((register) => /SunSpec ID/.test(register.name));
  assert.equal(sunSpecId.address, 40000);
  assert.equal(foxess.metadata.addressOffset, -1);
  assert.equal(foxess.registers.filter((register) => register.enabled === false && register.dataType === 'UINT32').length, 3);
});

test('six extended inverter devices are registered on TCP 502 with unit IDs 5-10', () => {
  const units = EXTENDED_KEYS.map((key) => simulatorDevices[key].configuration.unitId);
  assert.deepEqual(units, [5, 6, 7, 8, 9, 10]);
  assert.ok(EXTENDED_KEYS.every((key) => simulatorDevices[key].configuration.port === 502));
  assert.ok(EXTENDED_KEYS.every((key) => simulatorDevices[key].model.genericInverter === true));

  assert.deepEqual(
    ['em500', 'huawei', 'solis', 'sungrow'].map((key) => simulatorDevices[key].configuration.unitId),
    [1, 2, 3, 4],
  );
  assert.equal(new Set(Object.values(simulatorDevices).map((device) => device.configuration.unitId)).size, 10);
});

test('all six profiles generate telemetry and serve FC03/FC04 reads by unit ID', () => {
  const devices = Object.values(simulatorDevices);
  const vector = buildSharedVector(devices);

  try {
    for (const device of devices) {
      device.state = 'RUNNING';
      device.startedAt = new Date();
      device.model.startedAt = device.startedAt;
      device.tick();
    }

    for (const key of EXTENDED_KEYS) {
      const device = simulatorDevices[key];
      const profile = device.profile;
      const activeRegisters = profile.registers.filter((register) => register.enabled !== false);
      assert.equal(device.getValues().length, activeRegisters.length, key + ' generated every active register');

      for (const register of activeRegisters) {
        const sample = device.values.get(register.key);
        assert.ok(sample, key + ' missing telemetry for ' + register.key);
        if (typeof sample.value === 'number') {
          assert.ok(Number.isFinite(sample.value), key + ' emitted non-finite ' + register.key);
        }
      }

      const holding = activeRegisters.find((register) => register.registerType === 'HOLDING_REGISTER');
      assert.ok(holding, key + ' must expose holding registers');
      const holdingWords = vector.getMultipleHoldingRegisters(
        holding.address,
        holding.length,
        device.configuration.unitId,
      );
      assert.equal(holdingWords.length, holding.length);
      assert.ok(holdingWords.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff));

      const input = activeRegisters.find((register) => register.registerType === 'INPUT_REGISTER');
      if (input) {
        const inputWords = vector.getMultipleInputRegisters(
          input.address,
          input.length,
          device.configuration.unitId,
        );
        assert.equal(inputWords.length, input.length);
        assert.ok(inputWords.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff));
      }
    }

    const foxess = simulatorDevices.foxess;
    const sunSpecId = foxess.profile.registers.find((register) => /SunSpec ID/.test(register.name));
    const model707 = foxess.profile.registers.find((register) => register.key.includes('model_id_707'));
    const model708 = foxess.profile.registers.find((register) => register.key.includes('model_id_708'));
    const commonLength = foxess.profile.registers.find((register) => register.address === 40003);
    const model701Length = foxess.profile.registers.find((register) => register.address === 40071);
    const model707Length = foxess.profile.registers.find((register) => register.address === 40535);
    const model708Length = foxess.profile.registers.find((register) => register.address === 40593);
    const endModelId = foxess.profile.registers.find((register) => register.address === 40958);
    const endModelLength = foxess.profile.registers.find((register) => register.address === 40959);
    const model703 = foxess.profile.registers.find((register) => register.key.includes('model_id_703'));
    const model704 = foxess.profile.registers.find((register) => register.key.includes('model_id_704'));
    assert.equal(foxess.values.get(sunSpecId.key).value, 0x53756e53);
    assert.equal(foxess.values.get(commonLength.key).value, 66);
    assert.equal(foxess.values.get(model701Length.key).value, 153);
    assert.equal(foxess.values.get(model707.key).value, 707);
    assert.equal(foxess.values.get(model708.key).value, 708);
    assert.equal(foxess.values.get(model707Length.key).value, 56);
    assert.equal(foxess.values.get(model708Length.key).value, 56);
    assert.equal(foxess.values.get(endModelId.key).value, 0xffff);
    assert.equal(foxess.values.get(endModelLength.key).value, 0);
    assert.equal(foxess.values.get(model703.key).value, 703);
    assert.equal(foxess.values.get(model704.key).value, 704);

    const disabledFoxRegister = foxess.profile.registers.find((register) => register.enabled === false && register.dataType === 'UINT32');
    assert.throws(
      () => vector.getMultipleHoldingRegisters(
        disabledFoxRegister.address,
        disabledFoxRegister.length,
        foxess.configuration.unitId,
      ),
      (error) => error.modbusErrorCode === 0x02,
      'manual-overlap registers must not be served as live data',
    );

    const wrongUnit = simulatorDevices.sofar.profile.registers.find(
      (register) => register.registerType === 'HOLDING_REGISTER',
    );
    assert.throws(
      () => vector.getMultipleHoldingRegisters(wrongUnit.address, wrongUnit.length, 255),
      (error) => error.modbusErrorCode === 0x0b,
      'unknown unit IDs must not be routed to a different inverter',
    );
  } finally {
    devices.forEach(restoreDevice);
  }
});

test('FC16 control writes update each inverter model and remote stop commands', () => {
  const devices = EXTENDED_KEYS.map((key) => simulatorDevices[key]);
  const vector = buildSharedVector(Object.values(simulatorDevices));

  try {
    for (const device of devices) {
      device.state = 'RUNNING';
      device.startedAt = new Date();
      device.model.startedAt = device.startedAt;
      const simulator = device.profile.metadata.simulator;
      const unitId = device.configuration.unitId;

      const powerRegister = device.profile.registers.find(
        (register) => register.key === simulator.powerControlKey,
      );
      assert.ok(powerRegister?.writable, device.key + ' power-control register must be writable');
      const powerValue = simulator.powerControlMode === 'absolute-watts' ? 5000 : 50;
      const encodedPower = encodeRegister(powerRegister, powerValue);
      vector.setRegisterArray(powerRegister.address, encodedPower.rawValues, unitId);
      if (simulator.powerControlMode === 'absolute-watts') {
        assert.equal(device.model.fixedPowerLimitKw, 5);
      } else {
        assert.equal(device.model.deratingPct, 50);
      }

      if (simulator.remoteOnOffKey) {
        const remoteRegister = device.profile.registers.find(
          (register) => register.key === simulator.remoteOnOffKey,
        );
        assert.ok(remoteRegister?.writable, device.key + ' remote-control register must be writable');
        const stopValue = simulator.remoteControlBits === true
          ? 1
          : simulator.remoteOnOffEncoding === 'startup-shutdown'
            ? 0xde
            : 0;
        const encodedStop = encodeRegister(remoteRegister, stopValue);
        vector.setRegisterArray(remoteRegister.address, encodedStop.rawValues, unitId);
        assert.equal(device.model.remoteOn, false, device.key + ' remote stop write must stop output');
      }

      if (
        simulator.powerControlEnableKey
        && simulator.powerControlEnableKey !== simulator.remoteOnOffKey
      ) {
        const enableRegister = device.profile.registers.find(
          (register) => register.key === simulator.powerControlEnableKey,
        );
        assert.ok(enableRegister?.writable, device.key + ' power-control enable must be writable');
        const encodedDisable = encodeRegister(enableRegister, 0);
        vector.setRegisterArray(enableRegister.address, encodedDisable.rawValues, unitId);
        assert.equal(device.model.powerControlEnabled, false);
      }

      device.tick();
      if (simulator.remoteOnOffKey) {
        assert.equal(device.model.lastOutputKw, 0, device.key + ' output must be zero after remote stop');
      }
    }
  } finally {
    devices.forEach(restoreDevice);
  }
});

test('built-in seeding creates all six profiles and upgrades older built-in versions', async () => {
  const created = [];
  const repository = {
    findByIdentifier: async () => null,
    create: async (profile) => { created.push(profile); },
    updateById: async () => assert.fail('new profiles should not update'),
  };
  const results = await seedBuiltinProfiles(repository);
  assert.equal(created.length, 10);
  assert.equal(results.filter((result) => result.action === 'CREATED').length, 10);

  const existing = {
    _id: 'sofar-id',
    identifier: 'sofar-110ktl',
    builtIn: true,
    metadata: { profileVersion: 1 },
  };
  let updated = null;
  const createdDuringUpgrade = [];
  const upgradeRepository = {
    findByIdentifier: async (identifier) => identifier === existing.identifier ? existing : null,
    create: async (profile) => { createdDuringUpgrade.push(profile); },
    updateById: async (_id, profile) => { updated = profile; },
  };
  await seedBuiltinProfiles(upgradeRepository);
  assert.equal(updated.identifier, 'sofar-110ktl');
  assert.equal(updated.metadata.profileVersion, 2);
  assert.equal(createdDuringUpgrade.length, 9);
});
