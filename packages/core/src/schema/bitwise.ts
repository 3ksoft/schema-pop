import { Bit } from "./core";
import { scope } from "arktype";

/**
 * Bitwise for bit packed data.
 */
export const bitwise = scope({
    Bit,
    u1: "Bit<0 <= number <= 1, 1>",
    u2: "Bit<0 <= number <= 3, 2>",
    u3: "Bit<0 <= number <= 7, 3>",
    u4: "Bit<0 <= number <= 15, 4>",
    u5: "Bit<0 <= number <= 31, 5>",
    u6: "Bit<0 <= number <= 63, 6>",
    u7: "Bit<0 <= number <= 127, 7>",
});
