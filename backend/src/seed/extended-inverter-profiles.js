'use strict';

const SOFAR_MAP = require('./extended-register-maps/sofar-110ktl.json');
const GROWATT_MAP = require('./extended-register-maps/growatt-max.json');
const DEYE_MAP = require('./extended-register-maps/deye-nitrox-50kw.json');
const FOXESS_MAP = require('./extended-register-maps/foxess-r-v-h3plus.json');
const GOODWE_MAP = require('./extended-register-maps/goodwe-hybrid.json');
const ESINV_MAP = require('./extended-register-maps/esinv-33000id-hybrid.json');

function keyAt(registers, address, registerType = 'HOLDING_REGISTER') {
  return registers.find(
    (register) => register.address === address && register.registerType === registerType,
  )?.key;
}

function makeProfile(identifier, displayName, definition, controls = {}) {
  const {
    sourceUrl,
    addressing,
    addressOffset,
    ...simulatorControls
  } = controls;
  const registers = Object.freeze(definition.registers.map((register) => Object.freeze(register)));
  const tags = Object.freeze([
    definition.manufacturer.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    'inverter',
    'built-in',
    'manual-mapped',
  ]);
  return Object.freeze({
    identifier,
    name: displayName,
    description: `${definition.source}. ${definition.registerCount} documented register parameters are included.`,
    manufacturer: definition.manufacturer,
    model: definition.model,
    registers,
    isActive: true,
    maxReadQuantity: definition.maxReadQuantity || 125,
    tags,
    metadata: Object.freeze({
      profileVersion: 2,
      source: definition.source,
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(addressing ? { addressing } : {}),
      ...(addressOffset !== undefined ? { addressOffset } : {}),
      registerCount: registers.length,
      notes: [
        'Manufacturer register tables imported with address, access, data type, word length, scale factor, unit and source description. Reserved gaps are not invented.',
        definition.notes,
      ].filter(Boolean).join(' '),
      simulator: Object.freeze({
        genericInverter: true,
        ratingKw: definition.ratingKw,
        ...simulatorControls,
      }),
    }),
  });
}

const SOFAR_110KTL_PROFILE = makeProfile(
  'sofar-110ktl',
  'SOFAR 110KTL inverter',
  SOFAR_MAP,
  {
    sourceUrl: 'https://drive.google.com/file/d/1w7n2BHKOBV-zs1enzNzO2Y86zRo8TqDp/view',
    powerControlKey: keyAt(SOFAR_MAP.registers, 2305),
    powerControlEnableKey: keyAt(SOFAR_MAP.registers, 2304),
    remoteOnOffKey: keyAt(SOFAR_MAP.registers, 2304),
    remoteControlBits: true,
  },
);

const GROWATT_MAX_PROFILE = makeProfile(
  'growatt-max',
  'Growatt MAX 50-100K inverter',
  GROWATT_MAP,
  {
    sourceUrl: 'https://drive.google.com/file/d/1f_PtEQhFqvni5wYkYIZCzhN4pRkqdGj6/view',
    powerControlKey: keyAt(GROWATT_MAP.registers, 3),
    remoteOnOffKey: keyAt(GROWATT_MAP.registers, 0),
    powerControlMode: 'percent-255-unlimited',
  },
);

const DEYE_NITROX_50KW_PROFILE = makeProfile(
  'deye-nitrox-50kw',
  'Deye / NITROX 50kW 3-phase inverter',
  DEYE_MAP,
  {
    sourceUrl: 'https://drive.google.com/file/d/10dOowgYYibYXr8Y5JM5qNniaxQfrzNv0/view',
    powerControlKey: keyAt(DEYE_MAP.registers, 44),
    remoteOnOffKey: keyAt(DEYE_MAP.registers, 43),
  },
);

const FOXESS_RVH3_PROFILE = makeProfile(
  'foxess-r-v-h3plus',
  'FoxESS R / V / H3plus inverter',
  FOXESS_MAP,
  {
    sourceUrl: 'https://drive.google.com/file/d/1vRWJOxO-eS5ZzC83ZqLg_u3XVCKCNLXb/view',
    powerControlKey: keyAt(FOXESS_MAP.registers, 40300),
    powerControlEnableKey: keyAt(FOXESS_MAP.registers, 40299),
    addressOffset: -1,
    addressing: 'FoxESS SunSpec manual addresses are one-based; stored addresses are Modbus PDU offsets (manual address minus one). Register descriptions retain the manufacturer address.',
  },
);

const GOODWE_HYBRID_PROFILE = makeProfile(
  'goodwe-hybrid',
  'GoodWe Hybrid EN / 3EM inverter',
  GOODWE_MAP,
  {
    sourceUrl: 'https://drive.google.com/file/d/1XvQqYtvcPU0xyzXfZY4IDWuNGokdcBi4/view',
    powerControlKey: keyAt(GOODWE_MAP.registers, 0x0100),
  },
);

const ESINV_HYBRID_PROFILE = makeProfile(
  'esinv-33000id-hybrid',
  'ESINV-33000ID energy storage inverter',
  ESINV_MAP,
  {
    sourceUrl: 'https://drive.google.com/file/d/128BIZGVoqwRNozznQOHcGiPUErooRHch/view',
    powerControlKey: keyAt(ESINV_MAP.registers, 43128),
    powerControlEnableKey: keyAt(ESINV_MAP.registers, 43132),
    remoteOnOffKey: keyAt(ESINV_MAP.registers, 43007),
    powerControlMode: 'absolute-watts',
    remoteOnOffEncoding: 'startup-shutdown',
    powerControlEnableValue: 2,
  },
);

const EXTENDED_INVERTER_PROFILES = Object.freeze([
  SOFAR_110KTL_PROFILE,
  GROWATT_MAX_PROFILE,
  DEYE_NITROX_50KW_PROFILE,
  FOXESS_RVH3_PROFILE,
  GOODWE_HYBRID_PROFILE,
  ESINV_HYBRID_PROFILE,
]);

module.exports = {
  DEYE_NITROX_50KW_PROFILE,
  ESINV_HYBRID_PROFILE,
  EXTENDED_INVERTER_PROFILES,
  FOXESS_RVH3_PROFILE,
  GOODWE_HYBRID_PROFILE,
  GROWATT_MAX_PROFILE,
  SOFAR_110KTL_PROFILE,
};
