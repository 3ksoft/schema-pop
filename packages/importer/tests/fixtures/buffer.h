// Cut-down version of dnslib/buffer.h — exercises:
//  * `size_t` (system typedef → filtered out → downgraded to unknown)
//  * `std::vector<size_t>` (vec of unknown)
//  * a self-defined enum used as a field type (stays as ref)
#include <vector>
#include <cstdint>
#include <cstddef>

enum BufferResult {
    NoError,
    BufferOverflow,
};

struct Buffer {
    BufferResult bufResult;
    size_t bufLen;
    std::vector<size_t> domainLinkPos;
};
