#include <stdint.h>

uint32_t plain_func(uint8_t x);

__attribute__((stdcall)) int api_call(int a);
__attribute__((fastcall)) int fast_call(int a);
__attribute__((ms_abi)) void ms_abi_func(void);
__attribute__((sysv_abi)) void sysv_abi_func(void);
