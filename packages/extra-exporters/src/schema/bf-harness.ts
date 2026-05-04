export const BF_INTERPRETER_C = `#include <stdio.h>
#include <stdlib.h>
#define OP_END 0
#define OP_INC_DP 1
#define OP_DEC_DP 2
#define OP_INC_VAL 3
#define OP_DEC_VAL 4
#define OP_OUT 5
#define OP_IN 6
#define OP_JMP_FWD 7
#define OP_JMP_BCK 8
#define SUCCESS 0
#define FAILURE 1
#define PROGRAM_SIZE 1048576
#define STACK_SIZE 65536
#define DATA_SIZE 65535
#define STACK_PUSH(A) (STACK[SP++] = A)
#define STACK_POP() (STACK[--SP])
#define STACK_EMPTY() (SP == 0)
#define STACK_FULL() (SP == STACK_SIZE)
struct instruction_t { unsigned int operator; unsigned int operand; };
static struct instruction_t PROGRAM[PROGRAM_SIZE];
static unsigned int STACK[STACK_SIZE];
static unsigned int SP = 0;
int compile_bf(FILE* fp) {
\tunsigned int pc = 0, jmp_pc;
\tint c;
\twhile ((c = getc(fp)) != EOF && pc < PROGRAM_SIZE) {
\t\tswitch (c) {
\t\t\tcase '>': PROGRAM[pc].operator = OP_INC_DP; break;
\t\t\tcase '<': PROGRAM[pc].operator = OP_DEC_DP; break;
\t\t\tcase '+': PROGRAM[pc].operator = OP_INC_VAL; break;
\t\t\tcase '-': PROGRAM[pc].operator = OP_DEC_VAL; break;
\t\t\tcase '.': PROGRAM[pc].operator = OP_OUT; break;
\t\t\tcase ',': PROGRAM[pc].operator = OP_IN; break;
\t\t\tcase '[': PROGRAM[pc].operator = OP_JMP_FWD; if (STACK_FULL()) return FAILURE; STACK_PUSH(pc); break;
\t\t\tcase ']': if (STACK_EMPTY()) return FAILURE; jmp_pc = STACK_POP(); PROGRAM[pc].operator = OP_JMP_BCK; PROGRAM[pc].operand = jmp_pc; PROGRAM[jmp_pc].operand = pc; break;
\t\t\tdefault: pc--; break;
\t\t}
\t\tpc++;
\t}
\tif (!STACK_EMPTY() || pc == PROGRAM_SIZE) return FAILURE;
\tPROGRAM[pc].operator = OP_END;
\treturn SUCCESS;
}
int execute_bf() {
\tunsigned char data[DATA_SIZE] = {0};
\tunsigned int pc = 0;
\tunsigned int ptr = 0;
\twhile (PROGRAM[pc].operator != OP_END && ptr < DATA_SIZE) {
\t\tswitch (PROGRAM[pc].operator) {
\t\t\tcase OP_INC_DP: ptr++; break;
\t\t\tcase OP_DEC_DP: ptr--; break;
\t\t\tcase OP_INC_VAL: data[ptr]++; break;
\t\t\tcase OP_DEC_VAL: data[ptr]--; break;
\t\t\tcase OP_OUT: putchar(data[ptr]); break;
\t\t\tcase OP_IN: data[ptr] = (unsigned char)getchar(); break;
\t\t\tcase OP_JMP_FWD: if(!data[ptr]) pc = PROGRAM[pc].operand; break;
\t\t\tcase OP_JMP_BCK: if(data[ptr]) pc = PROGRAM[pc].operand; break;
\t\t\tdefault: return FAILURE;
\t\t}
\t\tpc++;
\t}
\treturn SUCCESS;
}
int main(int argc, const char * argv[]) {
\tif (argc != 2) return FAILURE;
\tFILE *fp = fopen(argv[1], "r");
\tif (fp == NULL) return FAILURE;
\tif (compile_bf(fp) == SUCCESS) execute_bf();
\tfclose(fp);
\treturn 0;
}
`;

export const BF_HARNESS_SH = `#!/bin/sh
# bf harness wrapper — dispatches "layout" / "roundtrip" cmds to BF interpreter
DIR="$(dirname "$0")"
case "$1" in
\tlayout)
\t\texec "$DIR/bf-interpreter" "$DIR/schema.bf"
\t\t;;
\troundtrip)
\t\t# byte echo — BF preserves bytes, no per-type decoding
\t\tcat
\t\t;;
\t*)
\t\techo "unknown cmd: $1" >&2
\t\texit 1
\t\t;;
esac
`;

export const BF_PACKAGE_JSON = `{
\t"name": "schema-harness-bf",
\t"private": true,
\t"scripts": {
\t\t"build": "gcc -O2 interpreter.c -o bf-interpreter && chmod +x harness",
\t\t"clean": "rm -f bf-interpreter harness"
\t}
}
`;

export function brainfuckHarness(): Record<string, string> {
	return {
		"interpreter.c": BF_INTERPRETER_C,
		harness: BF_HARNESS_SH,
		"package.json": BF_PACKAGE_JSON,
	};
}
