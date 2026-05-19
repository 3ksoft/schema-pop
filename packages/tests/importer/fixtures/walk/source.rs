#[repr(C)]
pub struct Battery {
    pub voltage_mv: u32,
    pub current_ma: i32,
    pub flags: u8,
}

pub struct Serial {
    pub bytes: [u8; 16],
}

pub struct Bundle {
    pub maybe: Option<u32>,
    pub samples: Vec<i16>,
}

#[repr(u8)]
pub enum Status {
    Idle,
    Active,
    Suspended,
}

pub type DeviceId = u32;

/// Battery info packet.
pub struct BatteryDoc {
    /// Voltage in millivolts.
    pub voltage_mv: u32,
}

pub struct Wrapper<T> { pub inner: T }

pub struct Inner { pub v: u32 }
pub struct Outer { pub inner: Inner }

pub fn add(a: u32, b: u32) -> u32 { a + b }
pub extern "C" fn cb(x: i32) {}

extern "C" {
    pub fn libc_sleep(secs: u32) -> i32;
    pub fn libc_exit(code: i32);
}

pub fn id<T>(x: T) -> T { x }

/// Compute checksum.
pub fn checksum(data: u32) -> u32 { 0 }