typedef struct {
    uint32_t voltage_mv;
    int32_t current_ma;
    uint8_t flags;
} Battery;

struct RawFrame {
    uint16_t length;
    uint8_t channel;
};

typedef enum {
    DS_IDLE,
    DS_ACTIVE,
    DS_ERROR
} DeviceStatus;

typedef uint32_t DeviceId;

typedef struct {
    uint8_t bytes[16];
} Serial;

typedef struct {
    uint32_t x;
} Inner;

typedef struct {
    Inner inner;
} Outer;

typedef struct {
    float a;
    double b;
    _Bool c;
    char d;
} Mix;

typedef struct {
    int valid : 1;
    void (*callback)(int);
    int *next;
} Quirky;

/** Battery payload. */
typedef struct {
    /** Voltage. */
    uint32_t voltage_mv;
} BatteryDoc;

void device_reset(uint32_t id);
uint32_t get_tick(void);
Battery* battery_get(uint32_t id, uint8_t flags);
/** Compute CRC. */
uint32_t crc32(const uint8_t* data, uint32_t len);