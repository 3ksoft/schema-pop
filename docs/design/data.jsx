// Sample schema across two versions.
const SCHEMA_DATA = {
  meta: { project: "telemetry.proto", layout: "Little Endian", generated: "2026-04-30T11:24:08Z" },
  versions: [
    {
      id: "1.0", label: "Version 1.0", released: "2025-08-12",
      summary: "Initial release. Sensor + battery telemetry over UART.",
      types: [
        { name: "DeviceStatus", kind: "enum", size: 1, align: 1,
          docstring: "Top-level device state. Reported every 100 ms.",
          variants: [{tag:0,name:"Active"},{tag:1,name:"Error"},{tag:2,name:"Idle"}] },
        { name: "BatteryInfo", kind: "struct", size: 4, align: 2,
          docstring: "Instantaneous battery readings, sampled by the PMIC.",
          fields: [
            { offset:0, name:"current", type:"i16", size:2, range:"−32768 … 32767" },
            { offset:2, name:"voltage", type:"u16", size:2, range:"0 … 65535" },
          ]},
        { name: "SensorFrame", kind: "struct", size: 12, align: 4,
          docstring: "Single sample from the IMU bundle.",
          fields: [
            { offset:0,  name:"timestamp", type:"u32", size:4 },
            { offset:4,  name:"ax",        type:"i16", size:2 },
            { offset:6,  name:"ay",        type:"i16", size:2 },
            { offset:8,  name:"az",        type:"i16", size:2 },
            { offset:10, name:"_pad",      type:"—",   size:0, pad:2 },
          ]},
        { name: "MacAddress", kind: "alias", size: 6, align: 1,
          docstring: "EUI-48 device identifier.", aliasOf: "[u8; 6]" },
      ]
    },
    {
      id: "2.0", label: "Version 2.0", released: "2026-02-03",
      summary: "Wider integers for solar harvesting. New LowBattery state.",
      types: [
        { name: "DeviceStatus", kind: "enum", size: 1, align: 1,
          docstring: "Top-level device state. Reported every 100 ms.",
          variants: [{tag:0,name:"Active"},{tag:1,name:"Error"},{tag:2,name:"Idle"},{tag:3,name:"LowBattery",added:true}] },
        { name: "BatteryInfo", kind: "struct", size: 8, align: 4,
          docstring: "Instantaneous battery readings, sampled by the PMIC.",
          fields: [
            { offset:0, name:"current", type:"i32", size:4, range:"−2,147,483,648 … 2,147,483,647", widened:true },
            { offset:4, name:"voltage", type:"u32", size:4, range:"0 … 4,294,967,295", widened:true },
          ]},
        { name: "SensorFrame", kind: "struct", size: 12, align: 4,
          docstring: "Single sample from the IMU bundle.",
          fields: [
            { offset:0,  name:"timestamp", type:"u32", size:4 },
            { offset:4,  name:"ax",        type:"i16", size:2 },
            { offset:6,  name:"ay",        type:"i16", size:2 },
            { offset:8,  name:"az",        type:"i16", size:2 },
            { offset:10, name:"_pad",      type:"—",   size:0, pad:2 },
          ]},
        { name: "SolarInput", kind: "struct", size: 8, align: 4, added: true,
          docstring: "Reading from the photovoltaic harvester. New in 2.0.",
          fields: [
            { offset:0, name:"power_mw",   type:"u32", size:4 },
            { offset:4, name:"panel_temp", type:"i16", size:2 },
            { offset:6, name:"_pad",       type:"—",   size:0, pad:2 },
          ]},
        { name: "MacAddress", kind: "alias", size: 6, align: 1, aliasOf: "[u8; 6]",
          docstring: "EUI-48 device identifier." },
      ]
    },
  ],
  diffs: [{
    from: "1.0", to: "2.0",
    changes: [
      { type: "DeviceStatus", status: "modified",  note: "+1 variant: LowBattery" },
      { type: "BatteryInfo",  status: "modified",  note: "Size 4 → 8, Align 2 → 4. i16→i32, u16→u32." },
      { type: "SensorFrame",  status: "unchanged", note: "Wire-compatible" },
      { type: "SolarInput",   status: "added",     note: "New struct" },
      { type: "MacAddress",   status: "unchanged", note: "Wire-compatible" },
    ]
  }],
};
window.SCHEMA_DATA = SCHEMA_DATA;
