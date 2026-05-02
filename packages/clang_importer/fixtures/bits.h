#include <stdint.h>

/** 8-bit register packed into mode + retries. */
struct StatusFlags {
    uint8_t enabled : 1;
    uint8_t mode    : 3;
    uint8_t retries : 4;
};

/** 32-bit control register with mixed widths. */
struct ControlRegister {
    uint32_t ready    : 1;
    uint32_t fault    : 1;
    uint32_t opcode   : 6;
    uint32_t channel  : 4;
    uint32_t priority : 4;
    uint32_t reserved : 16;
};

/** Mix of bitfields and regular fields. */
struct PacketHeader {
    uint8_t version : 4;
    uint8_t flags : 4;
    uint16_t length;
    uint32_t crc;
};
