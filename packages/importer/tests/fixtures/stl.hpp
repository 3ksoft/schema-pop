#include <vector>
#include <string>
#include <optional>
#include <array>
#include <cstdint>

struct WithSTL {
    std::string name;
    std::vector<uint8_t> bytes;
    std::array<uint32_t, 16> packets;
    std::optional<uint32_t> maybe_count;
    /// nested templates → unsupported, fall through to skipped
    std::vector<std::vector<uint8_t>> chunks;
    std::pair<int, int> point;
};
