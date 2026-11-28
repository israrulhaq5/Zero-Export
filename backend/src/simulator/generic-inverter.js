'use strict';

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value)));
}

function clampToRegisterRange(value, register) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  const ranges = {
    INT16: [-32768, 32767],
    UINT16: [0, 65535],
    INT32: [-2147483648, 2147483647],
    UINT32: [0, 4294967295],
  };
  const range = ranges[register.dataType];
  if (!range) return value;
  const scale = Number(register.scaleFactor) || 1;
  const offset = Number(register.offset) || 0;
  const raw = Math.round((value - offset) / scale);
  return clamp(raw, range[0], range[1]) * scale + offset;
}

function createGenericInverterModel(profile) {
  const simulator = profile.metadata?.simulator || {};
  return {
    genericInverter: true,
    manufacturer: profile.manufacturer || 'Generic',
    modelName: profile.model || profile.name,
    serialNumber: 'SIM-' + String(profile.identifier || 'INV').toUpperCase() + '-000001',
    ratingKw: Number(simulator.ratingKw) || 100,
    deratingPct: 100,
    powerControlEnabled: true,
    remoteOn: true,
    fixedPowerLimitKw: 0,
    phaseVoltage: [230.2, 231.0, 229.6],
    frequency: 50.01,
    totalYieldKwh: 12345.6,
    dailyYieldKwh: 142.3,
    totalChargeKwh: 321.4,
    totalDischargeKwh: 287.6,
    gridImportKwh: 4521.3,
    gridExportKwh: 218.7,
    batterySoc: 78.5,
    batterySoh: 97.2,
    runningHours: 12345,
    lastOutputKw: 0,
  };
}

function applyGenericInverterWrite(device, definition, value) {
  const model = device.model;
  const simulator = device.profile.metadata?.simulator || {};
  const numeric = Number(value);

  if (definition.key === simulator.remoteOnOffKey) {
    if (simulator.remoteControlBits === true) {
      const bits = Math.round(numeric);
      model.powerControlEnabled = (bits & 0x01) !== 0;
      model.remoteOn = (bits & 0x02) !== 0;
    } else if (simulator.remoteOnOffEncoding === 'startup-shutdown') {
      model.remoteOn = Math.round(numeric) === 0xbe;
    } else {
      model.remoteOn = numeric !== 0;
    }
  }

  if (
    definition.key === simulator.powerControlEnableKey &&
    simulator.remoteControlBits !== true
  ) {
    const enableValue = Number(simulator.powerControlEnableValue ?? 1);
    model.powerControlEnabled = Math.round(numeric) === enableValue;
  }

  if (definition.key === simulator.powerControlKey) {
    if (simulator.powerControlMode === 'absolute-watts') {
      model.fixedPowerLimitKw = Math.abs(numeric) / 1000;
    } else if (simulator.powerControlMode === 'percent-255-unlimited' && Math.round(numeric) === 255) {
      model.deratingPct = 100;
    } else {
      model.deratingPct = clamp(numeric, 0, 110);
    }
  }
}

function unitValue(value, unit) {
  const normalized = String(unit || '')
    .trim()
    .toLowerCase()
    .replace(/^[-+]?\d+(?:\.\d+)?\s*/, '')
    .replace(/\s+/g, '');
  if (normalized === 'mwh') return value / 1000;
  if (normalized === 'wh') return value * 1000;
  if (['w', 'va', 'var', 'ma', 'mv'].includes(normalized)) return value * 1000;
  if (['kw', 'kva', 'kvar'].includes(normalized)) return value;
  return value;
}

function splitHighLow(register, value) {
  const name = String(register.name || '').toLowerCase();
  const key = String(register.key || '').toLowerCase();
  const high = /\bhigh\b|(?:^|[\s_])h(?:$|[\s_])/.test(name + ' ' + key);
  const low = /\blow\b|(?:^|[\s_])l(?:$|[\s_])/.test(name + ' ' + key);
  if ((!high && !low) || Number(register.length || 1) !== 1) return null;

  const scale = Number(register.scaleFactor) || 1;
  const rawSigned = Math.round(Number(value) / scale);
  const rawUnsigned = ((rawSigned % 0x100000000) + 0x100000000) % 0x100000000;
  const word = high ? Math.floor(rawUnsigned / 0x10000) : rawUnsigned & 0xffff;
  const encodedWord = register.dataType === 'INT16' && word >= 0x8000
    ? word - 0x10000
    : word;
  return encodedWord * scale;
}

function valueForRegister(device, register, context) {
  const model = device.model;
  const simulator = device.profile.metadata?.simulator || {};
  if (device.controlValues.has(register.key)) {
    return device.controlValues.get(register.key);
  }

  const key = String(register.key || '').toLowerCase();
  const name = String(register.name || '').toLowerCase();
  const description = String(register.description || '').toLowerCase();
  const label = key + ' ' + name + ' ' + description;
  const unit = String(register.unit || '').toLowerCase();

  if (register.dataType === 'STRING') {
    const source = (/(serial|sn\b)/.test(label) ? model.serialNumber
      : /manufacturer/.test(label) ? model.manufacturer
        : /model/.test(label) ? model.modelName
          : 'SIMULATOR').padEnd(64, ' ');
    const start = register.length === 1 ? (register.address % 24) : 0;
    return source.slice(start, start + register.length * 2);
  }

  if (register.writable && !/model_id|number_of_the_following/.test(key)) {
    if (register.key === simulator.powerControlKey) {
      return simulator.powerControlMode === 'absolute-watts'
        ? model.fixedPowerLimitKw * 1000
        : model.deratingPct;
    }
    if (register.key === simulator.powerControlEnableKey) {
      if (simulator.remoteControlBits === true) {
        return (model.powerControlEnabled ? 1 : 0) | (model.remoteOn ? 2 : 0);
      }
      return model.powerControlEnabled ? Number(simulator.powerControlEnableValue ?? 1) : 0;
    }
    if (register.key === simulator.remoteOnOffKey) {
      if (simulator.remoteControlBits === true) {
        return (model.powerControlEnabled ? 1 : 0) | (model.remoteOn ? 2 : 0);
      }
      if (simulator.remoteOnOffEncoding === 'startup-shutdown') return model.remoteOn ? 0xbe : 0xde;
      return model.remoteOn ? 1 : 0;
    }
    return 0;
  }

  if (/fault|alarm|warning|error|trip|diagnostic|debug/.test(label)) return 0;
  if (/sunspec.*id/.test(label)) {
    const magic = description.match(/0x([0-9a-f]+)/i);
    return magic ? Number.parseInt(magic[1], 16) : 0x53756e53;
  }
  if (/number of the following modbus registers|model length|sunspec.*length/.test(label)) {
    const length = description.match(/\(l\)\s*:\s*(\d+)/i);
    return length ? Number(length[1]) : 0;
  }
  if (/end.*model.*id/.test(label)) return 0xffff;
  if (/end.*model.*length/.test(label)) return 0;
  if (/system_state/.test(key)) return 2;
  if (/status|state|mode/.test(label)) return context.running ? 1 : 2;
  if (/model_id/.test(key)) {
    const modelId = description.match(/model\s+id[^0-9]*(\d+)/i);
    return modelId ? Number(modelId[1]) : 1;
  }
  if (/serial|product_model_number|device_type|modbus_address/.test(key)) return 1;
  if (/aging_test_ok/.test(key)) return 1;
  if (/pviso/.test(key)) return 1200;
  if (/pid_bus/.test(key)) return context.pvVoltage * 1.4;
  if (/ct_i_[rst]/.test(key)) return context.phaseCurrent;
  if (/ct_har_i_[rst]|comp_har_i_[rst]/.test(key)) return context.phaseCurrent * 0.05;
  if (/[rst]_dci/.test(key)) return 150;
  if (/power[_ ]factor|\bpf\b/.test(label)) return context.powerFactor;
  if (/frequency|freq/.test(label)) return context.frequency;
  if (/temperature|temp/.test(label)) return 42.3;
  if (/\bsoh\b|health/.test(label)) return model.batterySoh;
  if (/\bsoc\b|state_of_charge/.test(label)) return model.batterySoc;
  if (/battery_voltage/.test(label)) return 520;
  if (/battery_current/.test(label)) return -18.5;
  if (/battery.*charge.*power|charge.*power/.test(label)) return 2.1;
  if (/battery.*discharge.*power|discharge.*power/.test(label)) return 1.7;
  if (/work_time|running_time|total.*hours/.test(label)) return model.runningHours;

  if (/energy|yield|kwh/.test(label)) {
    let energy = /battery.*charge|charge.*energy/.test(label) ? model.totalChargeKwh
      : /battery.*discharge|discharge.*energy/.test(label) ? model.totalDischargeKwh
        : /import/.test(label) ? model.gridImportKwh
          : /export/.test(label) ? model.gridExportKwh
            : /today|daily|day/.test(label) ? model.dailyYieldKwh
              : model.totalYieldKwh;
    if (/wh/.test(unit) && !/kwh/.test(unit)) energy *= 1000;
    if (/mwh/.test(unit)) energy /= 1000;
    const pairValue = splitHighLow(register, energy);
    return pairValue === null ? energy : pairValue;
  }

  if (/line|phase_ab|phase_bc|phase_ac|voltage.*(?:ab|bc|ac)|(?:ab|bc|ac).*voltage/.test(label)) {
    return context.averageVoltage * Math.sqrt(3);
  }
  if (/battery.*voltage/.test(label)) return 520;
  if (/pv|mppt|dc_voltage|bus_voltage/.test(label) && /voltage/.test(label)) return context.pvVoltage;
  if (/phase[_ ]?[abc].*voltage|voltage.*phase|voltage_phase/.test(label)) {
    const phase = /phase[_ ]?b|phase l2|phase s/.test(label) ? 1
      : /phase[_ ]?c|phase l3|phase t/.test(label) ? 2 : 0;
    return model.phaseVoltage[phase];
  }
  if (/grid[_ ]voltage|load[_ ]voltage|voltage[_ ]grid/.test(label)) return context.averageVoltage;

  if (/pv|mppt|dc_current|string.*current/.test(label) && /current/.test(label)) {
    return context.pvCurrent;
  }
  if (/phase[_ ]?[abc].*current|grid[_ ]current|load[_ ]current|current.*phase|current.*ct/.test(label)) {
    return context.phaseCurrent;
  }

  if (/(rated|nominal|max(?:imum)?)/.test(label) && /power/.test(label)) {
    return unitValue(context.ratingKw, unit);
  }
  if (/apparent_power|apparent power/.test(label)) {
    const value = unitValue(context.outputKw / context.powerFactor, unit);
    const pairValue = splitHighLow(register, value);
    return pairValue === null ? value : pairValue;
  }
  if (/reactive_power|reactive power/.test(label)) {
    const value = unitValue(context.outputKw * 0.08, unit);
    const pairValue = splitHighLow(register, value);
    return pairValue === null ? value : pairValue;
  }
  if (/active_power|active power|output_power|output power|pac\b/.test(label)) {
    let kw = context.outputKw;
    if (/load/.test(label)) kw = context.loadKw;
    else if (/pcc|grid|import|export/.test(label)) kw = context.gridKw;
    else if (/pv|input/.test(label)) kw = context.dcPowerKw;
    const value = unitValue(kw, unit);
    const pairValue = splitHighLow(register, value);
    return pairValue === null ? value : pairValue;
  }
  if (/power|watt|pmax|ppv|pac/.test(label)) {
    const kw = /load/.test(label) ? context.loadKw
      : /grid|pcc/.test(label) ? context.gridKw
        : /pv|input/.test(label) ? context.dcPowerKw
          : context.outputKw;
    const value = unitValue(kw, unit);
    const pairValue = splitHighLow(register, value);
    return pairValue === null ? value : pairValue;
  }
  return 0;
}

function computeGenericInverter(device) {
  const model = device.model;
  const options = device.configuration.options || {};
  const ratingKw = Math.max(0.1, Number(options.ratingKw ?? model.ratingKw ?? 100));
  const availabilityPct = clamp(options.availabilityPct ?? 80, 0, 100);
  const loadKw = Math.max(0, Number(options.loadKw ?? 100));
  const deratingPct = model.powerControlEnabled ? clamp(model.deratingPct, 0, 110) : 100;
  const running = Boolean(model.startedAt || device.state === 'RUNNING');
  let outputKw = running && model.remoteOn
    ? ratingKw * (availabilityPct / 100) * (deratingPct / 100) * (0.985 + Math.random() * 0.03)
    : 0;
  if (model.fixedPowerLimitKw > 0) outputKw = Math.min(outputKw, model.fixedPowerLimitKw);

  model.phaseVoltage = model.phaseVoltage.map((value) =>
    clamp(value + (Math.random() - 0.5) * 0.3, 225, 240),
  );
  model.frequency = clamp(model.frequency + (Math.random() - 0.5) * 0.015, 49.9, 50.1);

  const averageVoltage = model.phaseVoltage.reduce((sum, value) => sum + value, 0) / 3;
  const powerFactor = 0.99;
  const phaseCurrent = (outputKw * 1000) / (3 * averageVoltage * powerFactor);
  const dcPowerKw = outputKw / 0.982;
  const pvVoltage = 590 + Math.random() * 30;
  const pvCurrent = (dcPowerKw * 1000) / (8 * pvVoltage);
  const gridKw = loadKw - outputKw;
  const deltaHours = Math.max(100, Number(device.configuration.updateIntervalMs) || 1000) / 3600000;

  if (running) {
    model.runningHours += deltaHours;
    model.totalYieldKwh += outputKw * deltaHours;
    model.dailyYieldKwh += outputKw * deltaHours;
    model.totalChargeKwh += 0.15 * deltaHours;
    model.totalDischargeKwh += 0.12 * deltaHours;
    model.gridImportKwh += Math.max(gridKw, 0) * deltaHours;
    model.gridExportKwh += Math.max(-gridKw, 0) * deltaHours;
  }
  model.lastOutputKw = outputKw;

  const context = {
    ratingKw,
    loadKw,
    outputKw,
    gridKw,
    dcPowerKw,
    averageVoltage,
    phaseCurrent,
    pvVoltage,
    pvCurrent,
    frequency: model.frequency,
    powerFactor,
    running,
  };

  return Object.fromEntries(
    device.profile.registers.map((register) => [
      register.key,
      clampToRegisterRange(valueForRegister(device, register, context), register),
    ]),
  );
}

module.exports = {
  applyGenericInverterWrite,
  computeGenericInverter,
  createGenericInverterModel,
};
