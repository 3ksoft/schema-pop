#pragma once
#include <cstdint>

namespace okon {

/// Battery telemetry payload.
struct Battery {
    uint32_t voltage_mv;
    int32_t current_ma;
    uint8_t flags;
};

/// 16-byte device serial number.
struct SerialNumber {
    uint8_t bytes[16];
};

/// Lifecycle.
enum class DeviceStatus : uint8_t {
    Idle,
    Active,
    Suspended,
    Error
};

using DeviceId = uint32_t;

class Bundle {
public:
    Battery battery;
    DeviceId id;
    float scale;
    boolean ready;

private:
    int internal_only;  // should NOT appear in output (private)
};

template <typename T>
struct Wrapper {
    T value;
};

}  // namespace okon
