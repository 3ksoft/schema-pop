namespace okon {
    struct Battery {
        uint32_t voltage_mv;
    };
    class Bundle {
    public:
        uint32_t id;
        float scale;
    private:
        int internal_only;
    };
    using DeviceId = uint32_t;
}

template <typename T>
struct Wrapper { T value; };

enum class Status : uint8_t {
    Idle, Active, Error
};

namespace okon {
    uint32_t do_thing(uint8_t x);
}

template <typename T>
T identity(T x) { return x; }
uint32_t plain(uint8_t x);