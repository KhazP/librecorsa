/* The only entry point used by the importer. See README.md to regenerate. */
#define BCDEC_STATIC
#define BCDEC_IMPLEMENTATION
#include "bcdec.h"

__attribute__((export_name("decode_row")))
void decode_row(const unsigned char *blocks, unsigned char *rgba, int count) {
    for (int i = 0; i < count; ++i) {
        bcdec_bc7(blocks + i * 16, rgba + i * 16, count * 16);
    }
}
