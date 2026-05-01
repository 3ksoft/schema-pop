// Sample Rust types for testing the schema-pop importer.

/// Battery telemetry packet — wire format v1.
#[repr(C)]
pub struct Battery {
    /// Voltage in millivolts.
    pub voltage_mv: u32,
    pub current_ma: i32,
    pub flags: u8,
}

/// 16-byte device serial number.
#[repr(C)]
pub struct SerialNumber {
    pub bytes: [u8; 16],
}

/// Lifecycle of a device.
#[repr(u8)]
pub enum DeviceStatus {
    Idle,
    Active,
    Suspended,
    Error,
}

/// Type alias for fixed-size IDs.
pub type DeviceId = u32;

// Should be skipped (generic).
pub struct Wrapper<T> {
    pub inner: T,
}

// Optional and Vec — should map to optional / array.
#[repr(C)]
pub struct Bundle {
    pub label: String,
    pub maybe_size: Option<u32>,
    pub samples: Vec<i16>,
    pub fixed: [f32; 4],
}

/// Read battery state from device. (Free function.)
pub fn battery_read(id: u32) -> DeviceStatus {
    DeviceStatus::Idle
}

/// Reset device — extern C ABI for FFI use.
pub extern "C" fn device_reset(id: u32) {}

extern "C" {
    /// Imported from libc-style external library.
    pub fn external_get_tick() -> u32;
}
