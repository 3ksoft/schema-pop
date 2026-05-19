#include <stdint.h>

/** Globally-unique device id assigned at provisioning. */
typedef uint32_t DeviceId;

/**
 * Wire-format header for every packet.
 * Versioned to allow forward-compatible upgrades.
 */
typedef struct {
    uint32_t version;     /**< protocol revision, increments per breaking change */
    uint16_t length;      ///< total payload length in bytes
    uint8_t flags;        // bitmask — runtime-only, no docs here
} Header;

/** Boot-time status of the firmware. */
typedef enum {
    /** All systems nominal. */
    STATUS_OK,
    /** Recoverable error. */
    STATUS_ERR,
} Status;

/**
 * Dispatch a packet to a peer.
 * @param pkt the packet to send
 * @param target the recipient device
 * @return 0 on success, negative errno on failure
 */
int dispatch(const Header* pkt, DeviceId target);
