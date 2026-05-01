import { Binary, Describe, Obsolete } from "./core";
import { scope } from "arktype";

/**
 * Base binary scope containing all FFI-safe primitives.
 * Ordered from smallest to largest to support first-match inference.
 */
export const binary = scope({
    Binary,
    Describe,
    Obsolete,
    bool: "Binary<boolean, 1, 1, 'bool'>",
    
    u8: "Binary<0 <= number <= 255, 1, 1, 'u8'>",
    i8: "Binary<-128 <= number <= 127, 1, 1, 'i8'>",
    
    u16: "Binary<0 <= number <= 65535, 2, 2, 'u16'>",
    i16: "Binary<-32768 <= number <= 32767, 2, 2, 'i16'>",
    
    u32: "Binary<0 <= number <= 4294967295, 4, 4, 'u32'>",
    i32: "Binary<-2147483648 <= number <= 2147483647, 4, 4, 'i32'>",
    
    i64: "Binary<bigint, 8, 8, 'i64'>",
    u64: "Binary<bigint, 8, 8, 'u64'>",

    i128: "Binary<bigint, 16, 8, 'i128'>",
    u128: "Binary<bigint, 16, 8, 'u128'>",

    f32: "Binary<number, 4, 4, 'f32'>",
    f64: "Binary<number, 8, 8, 'f64'>",
});
