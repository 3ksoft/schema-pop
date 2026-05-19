#include <stdint.h>

/** Plain — auto-padded by analyzer. */
struct Plain {
    uint32_t a;
    uint8_t b;
    uint16_t c;
    uint32_t d;
};

/** Wire format — byte-tight, no padding. */
struct __attribute__((packed)) Frame {
    uint8_t  type;
    uint16_t length;
    uint32_t timestamp;
};

/** Memory-mapped page — 4K alignment. */
struct __attribute__((aligned(4096))) PageHeader {
    uint8_t magic[4];
    uint32_t flags;
};

/** Both — packed AND aligned. */
struct __attribute__((packed,aligned(4))) WireMsg {
    uint8_t  tag;
    uint16_t value;
};
