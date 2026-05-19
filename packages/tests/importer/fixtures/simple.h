#include <stdint.h>

typedef uint32_t DeviceId;

typedef struct {
    uint32_t a;
    uint16_t b;
    uint8_t flags;
} Foo;

typedef enum {
    STATUS_OK = 0,
    STATUS_ERR = 1,
} Status;

int do_thing(Foo* foo, DeviceId id);
