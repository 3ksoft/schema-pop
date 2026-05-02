#include <cstdint>

namespace konektor {

using DeviceId = uint32_t;

struct Header {
    uint32_t version;
    uint16_t length;
    uint8_t flags;
};

enum class Status : uint8_t {
    OK = 0,
    ERR = 1,
    PENDING = 2,
};

struct Packet {
    Header hdr;
    uint8_t payload[64];
    Status status;
};

extern "C" int dispatch(const Packet* pkt, DeviceId target);
extern "C" void shutdown(void);

} // namespace konektor
