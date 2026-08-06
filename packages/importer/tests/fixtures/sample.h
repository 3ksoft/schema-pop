/* Battery telemetry packet — wire format v1. */

#include <stdint.h>
#include <stdbool.h>

/** Battery telemetry payload. */
typedef struct {
    /** Voltage in millivolts. */
    uint32_t voltage_mv;
    int32_t current_ma;
    uint8_t flags;
} Battery;

/** 16-byte device serial number. */
typedef struct {
    uint8_t bytes[16];
} SerialNumber;

/** Lifecycle of a device. */
typedef enum {
    DS_IDLE,
    DS_ACTIVE,
    DS_SUSPENDED,
    DS_ERROR
} DeviceStatus;

/** Type alias for fixed-size IDs. */
typedef uint32_t DeviceId;

/** Bare struct (no typedef). */
struct RawFrame {
    uint16_t length;
    uint8_t channel;
};

/** Composite — references another struct. */
typedef struct {
    Battery battery;
    DeviceId id;
    float scale;
    double precision;
    boolean ready;
} Bundle;

/* Bitfield + function pointer + pointer field — should be skipped. */
typedef struct {
    int valid : 1;
    int level : 3;
    void (*callback)(int);
    Battery *next;
} Quirky;

/** Read battery state from device. */
DeviceStatus battery_read(DeviceId id, Battery *out);

/** Reset device — fire and forget. */
void device_reset(DeviceId id);

/** No args. */
uint32_t get_tick_count(void);
