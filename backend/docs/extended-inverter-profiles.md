# Extended inverter simulator profiles

## Built-in profiles and Modbus identity

The simulator ships ten built-in devices on one shared Modbus TCP listener:

| Unit ID | Device |
| ---: | --- |
| 1 | EM500 meter |
| 2 | Huawei SUN2000 |
| 3 | Solis |
| 4 | Sungrow |
| 5 | SOFAR 110KTL |
| 6 | Growatt MAX 50–100K |
| 7 | Deye / NITROX 50kW |
| 8 | FoxESS R / V / H3plus |
| 9 | GoodWe Hybrid EN / 3EM |
| 10 | ESINV-33000ID |

All default to TCP port **502**. Devices on the same host/port are routed by Modbus Unit ID; they do not open ten competing listeners.

## Register maps

The six profile maps are seeded as built-ins and versioned at profile version 2. Register counts include documented disabled entries retained for traceability.

| Profile | Register definitions | Manual coverage notes |
| --- | ---: | --- |
| SOFAR 110KTL | 1,906 | Named workbook entries are mapped; the explicit reserved Production_Code slot is omitted. Four Super-admin password words are represented as read-only zero placeholders. |
| Growatt MAX 50–100K | 1,284 | Adds the omitted inverter diagnostics, debug words, control settings and three-phase AC measurements. SPH4–11K/SPA-only storage blocks, reserved addresses and ranges marked no-use are excluded from the MAX profile. |
| Deye / NITROX 50kW | 254 | Includes Meter Enable. The supplied document is V1.34; its register table identifies revision V1.33. |
| FoxESS R/V/H3plus | 559 | Includes SunSpec model IDs 707 and 708. Three overlapping Act Pt U32 entries from the supplied manual are retained but disabled because each two-word span collides with the next Dept Ref address. Model 701 length is reconciled to 153 (the manual prints 31, but Model 702 starts at manual address 40226); the required 0xFFFF/0 end marker is appended. |
| GoodWe Hybrid EN / 3EM | 154 | Includes the supplied ASCII and multi-register fields. |
| ESINV-33000ID | 768 | Includes the supplied runtime input-register and configuration holding-register tables. |

The register validator checks unique keys and start addresses. Regression tests additionally check that enabled register spans do not overlap.

## Address conventions

The FoxESS manual publishes SunSpec reference addresses such as 40001. The simulator's Modbus vector uses the address field sent in the Modbus PDU, so FoxESS profile addresses are normalized by subtracting one from the manual reference address. The original manufacturer address remains in each register description and the profile metadata records addressOffset = -1. Independent cross-check: https://github.com/HarshBhardwaj/foxess-local/blob/main/docs/02-frontend-decoder-and-register-map.md. The simulator returns the SunSpec identifier 0x53756e53, the manual's model IDs and model-length fields, plus the required 0xFFFF/0 end marker. Model 701 length is set to 153 based on the next model's documented start address and an independent decoded FoxESS map; this differs from the V1.07 manual's printed value of 31.

Other profiles retain the raw addresses published in their supplied register tables.

## Runtime behavior

- FC03 holding-register and FC04 input-register reads are served from the selected profile.
- FC16 writes are decoded using the same register encoder/decoder as the gateway and applied to the generic inverter control model.
- Power-limit writes update percent derating or absolute-watt limits according to each profile's control metadata.
- Remote stop/start and power-control-enable registers update the simulated operating state where documented.
- The meter's grid-point calculation includes output from all nine inverter simulators.
- Registers explicitly marked disabled are not populated or writable. The generic device defaults to exception responses for unmapped gaps rather than inventing zero-valued registers.

The generic model produces continuously varying telemetry for integration and acceptance testing. Generated numeric values are bounded to each register's declared integer range before encoding. It is not a firmware-exact electrical model; site commissioning against each physical inverter remains a separate validation step.

## Port 502 permissions

Port 502 is a privileged port on Linux and macOS. On Linux, run the service as its normal unprivileged user and grant only the bind capability, for example in the systemd service:

```ini
[Service]
User=simulator
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
```

Do not run the simulator as root solely to bind port 502. Ensure no other process is already listening on the selected host/port.

## CI

The .github/workflows/backend-ci.yml workflow runs the backend lint and complete Node test suite on the repository's self-hosted macOS ARM64 runner. GitHub-hosted runners are not used.
