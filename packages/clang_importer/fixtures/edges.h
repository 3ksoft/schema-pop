#include <stdint.h>

// Bitfields → skip
struct Flags {
    uint8_t a : 3;
    uint8_t b : 5;
};

// Multidim array
struct Grid {
    uint8_t cells[4][4];
};

// Function pointer in struct → field skip
struct Callbacks {
    void (*on_start)(void);
    uint32_t magic;
};

// Forward decl + later definition
struct Forward;
struct Forward {
    uint32_t x;
};

// `typedef struct Tag Tag` (named tag with typedef of same name)
typedef struct Named {
    uint32_t y;
} Named;

// Anonymous enum (no name) → silently skipped
enum {
    UNNAMED_VAL = 5,
};

// Constants via #define — clang expands these in fields
#define BUF_SIZE 32
struct Buffer {
    uint8_t bytes[BUF_SIZE];
};

// Self-referential struct via pointer — classic linked-list shape.
// Pointer field must NOT trigger topo-sort failure in computeLayoutPlan
// (the pointee layout is irrelevant — sizeof(void*) is enough).
struct Node {
    uint32_t value;
    struct Node *next;
};
