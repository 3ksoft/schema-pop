~/D/s / p / bench  bun run src / run.ts
correctness: {
  codec: true,
    hand: true,
      json: true,
        msgpack: true,
          msgpackRec: true,
            bebop: true,
}

payload sizes(bytes):
ts:codec     332
hand - DataView 332
  bebop        293
msgpackr + rec 611
  msgpackr     826
  JSON         1478

clk: ~0.70 GHz
cpu: AMD Ryzen 5 2600 Six - Core Processor
runtime: bun 1.3.9(x64 - linux)

benchmark                   avg(min … max) p75 / p99(min … top 1 %)
------------------------------------------- -------------------------------
• encode
------------------------------------------- -------------------------------
  ts:codec                     259.37 ns / iter 296.99 ns    ▄   ▃█▆▃
(122.43 ns … 856.76 ns) 483.25 ns    ███▇████
(0.00  b …  64.00  b) 1.44  b ▂███████████▅▇▅▆▃▃▂▂▂

hand - DataView                201.18 ns / iter 228.95 ns    ▆█▄▂
(122.61 ns … 560.58 ns) 381.92 ns    ████▇█▆▃
(0.00  b …  32.00  b) 0.04  b ▆▇▇████████▅▃▃▂▂▁▁▁▁▁

JSON.stringify                 9.77 µs / iter  10.28 µs                     █
(8.62 µs … 10.89 µs) 10.46 µs            █        █
(0.00  b …   1.63 kb) 1.20 kb █▁▁█▁██▁▁▁██▁██▁▁▁█▁█

msgpackr                      16.48 µs / iter  17.75 µs   █
(7.99 µs … 729.56 µs) 61.99 µs █▃█▆
(0.00  b … 256.00 kb) 1.32 kb ████▇▆▄▃▃▂▂▁▁▁▁▁▁▁▁▁▁

msgpackr + records              14.94 µs / iter  16.54 µs   █
(6.59 µs … 339.29 µs) 52.95 µs  ▅█▆▄
(0.00  b … 128.00 kb) 935.18  b ▅████▇▅▃▂▂▂▁▁▁▁▁▁▁▁▁▁

bebop                          8.31 µs / iter   9.85 µs  █▆
(2.58 µs … 353.19 µs) 37.59 µs ▅██
(0.00  b … 128.00 kb) 1.74 kb ████▇▇▅▃▃▂▂▂▂▁▁▁▁▁▁▁▁

summary
hand - DataView
1.29x faster than ts: codec
41.32x faster than bebop
48.58x faster than JSON.stringify
74.29x faster than msgpackr + records
81.91x faster than msgpackr

• decode
------------------------------------------- -------------------------------
  ts:codec                     694.66 ns / iter 645.80 ns   █▄
(357.20 ns … 2.12 µs) 2.07 µs  ▄██
(0.00  b …   1.50 kb) 73.64  b ▁███▆▃▁▂▁▃▂▂▂▂▁▁▂▂▁▂▂

hand - DataView                572.15 ns / iter 590.56 ns   █▇▅
(326.88 ns … 1.67 µs) 1.51 µs   ███▅
(0.00  b … 192.00  b) 1.25  b ▄█████▄▂▂▁▁▁▂▁▂▂▂▃▁▁▁

JSON.parse                    17.36 µs / iter  17.63 µs             █
(15.85 µs … 19.28 µs) 18.92 µs     █       █
(0.00  b …   1.75 kb) 1.07 kb █▁█▁█▁▁▁█▁███▁▁▁▁▁▁▁█

msgpackr                      27.78 µs / iter  31.04 µs    ▆██▂
(12.40 µs … 2.18 ms) 65.60 µs  █▆████▆▂
(0.00  b … 128.00 kb) 2.86 kb ▂████████▇▆▄▄▃▂▂▂▂▁▁▁

msgpackr + records              21.54 µs / iter  25.18 µs   ▂█▇▄
(8.85 µs … 316.70 µs) 56.91 µs  █████▆▃
(0.00  b … 128.00 kb) 2.32 kb ▆████████▇▅▄▄▃▂▂▂▂▂▁▁

bebop                          4.51 µs / iter   5.36 µs  █
(920.00 ns … 325.45 µs) 24.63 µs ▇█
(0.00  b … 128.00 kb) 1.43 kb ███▅▅▄▃▃▂▂▂▂▁▁▁▁▁▁▁▁▁

summary
hand - DataView
1.21x faster than ts: codec
7.89x faster than bebop
30.33x faster than JSON.parse
37.65x faster than msgpackr + records
48.55x faster than msgpackr

• roundtrip
------------------------------------------- -------------------------------
  ts:codec                     986.74 ns / iter   1.06 µs     ▃█▅▂
(558.93 ns … 2.13 µs) 1.95 µs   ▅█████▆
(0.00  b …   1.50 kb) 37.56  b ▂▆███████▅▃▃▅▂▁▃▁▃▂▂▃

hand - DataView                  1.02 µs / iter   1.11 µs     ▆█▂▄
(567.04 ns … 2.15 µs) 1.95 µs   ▃▆█████▂
(0.00  b … 288.00  b) 3.75  b ▃▂████████▆▃▂▁▃▁▂▄▁▂▃

JSON                          29.42 µs / iter  30.21 µs            ██  █
(25.30 µs … 32.06 µs) 31.85 µs ▅    ▅     ██▅ █  ▅ ▅
(0.00  b …   3.34 kb) 1.20 kb █▁▁▁▁█▁▁▁▁▁███▁█▁▁█▁█

msgpackr                      38.18 µs / iter  38.70 µs  █
(33.99 µs … 46.74 µs) 45.31 µs  █  █
(0.00  b …   5.16 kb) 757.44  b ███▁█▁█▁█▁▁▁▁▁▁▁▁▁▁██

msgpackr + records              38.77 µs / iter  44.50 µs   ▂▆██▆
(17.09 µs … 546.45 µs) 88.40 µs  ▆██████▆▂
(0.00  b … 384.00 kb) 3.21 kb ▄██████████▆▅▄▃▂▂▂▂▂▁

bebop                          7.68 µs / iter   9.19 µs                   █
(6.09 µs … 9.69 µs) 9.55 µs ▂▇▂   ▂           █
(0.00  b …   3.38 kb) 945.00  b ███▁▁▆█▁▁▁▆▁▁▁▁▁▁▁█▁▆

summary
ts: codec
1.03x faster than hand - DataView
7.79x faster than bebop
29.82x faster than JSON
38.7x faster than msgpackr
39.29x faster than msgpackr + records
~/D/s / p / bench  bun run src / runText.ts
payload sizes(bytes):
ts:codec     1220(fixed - size string slots)
  bebop        393
msgpackr + rec 431
  msgpackr     519
  JSON         594

clk: ~1.39 GHz
cpu: AMD Ryzen 5 2600 Six - Core Processor
runtime: bun 1.3.9(x64 - linux)

benchmark                   avg(min … max) p75 / p99(min … top 1 %)
------------------------------------------- -------------------------------
• encode
------------------------------------------- -------------------------------
  ts:codec                      15.94 µs / iter  18.34 µs   █          █
(10.82 µs … 24.51 µs) 19.64 µs ▅ █▅  ▅      █  ▅▅▅ ▅
(0.00  b …   5.50 kb) 2.91 kb █▁██▁▁█▁▁▁▁▁▁█▁▁███▁█

JSON.stringify                 2.20 µs / iter   2.68 µs    ▆█
(1.47 µs … 3.14 µs) 3.10 µs  ▇ ███▂       ▅ ▅ ▅▂
(0.00  b … 864.00  b) 339.99  b ▆█▃████▃▃▆▁▃▃██▆████▃

msgpackr                       7.05 µs / iter   6.91 µs  █
(2.83 µs … 713.97 µs) 33.19 µs ▃█▃
(0.00  b … 896.00 kb) 944.01  b ███▄▄▃▃▂▂▂▁▁▁▁▁▁▁▁▁▁▁

msgpackr + records               7.06 µs / iter   7.16 µs  █
(3.05 µs … 140.23 µs) 33.95 µs ▃█▇
(0.00  b … 128.00 kb) 710.20  b ███▇▄▃▂▂▂▂▁▁▁▁▁▁▁▁▁▁▁

bebop                          8.40 µs / iter  10.03 µs  █
(2.26 µs … 372.05 µs) 37.30 µs ▂██▂
(0.00  b … 256.00 kb) 2.19 kb █████▇▅▃▃▂▂▂▂▁▁▁▁▁▁▁▁

summary
JSON.stringify
3.2x faster than msgpackr
3.2x faster than msgpackr + records
3.81x faster than bebop
7.23x faster than ts: codec

• decode
------------------------------------------- -------------------------------
  ts:codec                       7.12 µs / iter   8.33 µs  █
(1.99 µs … 274.35 µs) 35.68 µs  █▄
(0.00  b … 128.00 kb) 1.70 kb ███▆▆▅▃▂▂▂▂▂▁▁▁▁▁▁▁▁▁

JSON.parse                     5.05 µs / iter   5.26 µs                 █
(4.34 µs … 5.61 µs) 5.51 µs ▂        ▂▂▂▇▇▇ █  ▂
(0.00  b …   1.00 kb) 642.65  b █▁▆▆▁▁▆▁▁██████▆█▆▁█▆

msgpackr                      13.12 µs / iter  14.90 µs   █
(5.61 µs … 919.42 µs) 39.58 µs  ▃██▂
(0.00  b … 384.00 kb) 1.57 kb ▅█████▆▅▄▃▃▂▂▂▂▁▁▁▁▁▁

msgpackr + records              21.19 µs / iter  23.66 µs   █▆▃
(7.86 µs … 1.25 ms) 66.41 µs  ████▃
(0.00  b … 128.00 kb) 2.05 kb ▆██████▇▅▄▃▃▂▂▂▂▁▁▁▁▁

bebop                         10.96 µs / iter  14.20 µs  █▂
(3.02 µs … 1.11 ms) 42.07 µs  ██
(0.00  b … 256.00 kb) 3.24 kb ▇███▅▅▅▅▅▄▃▂▂▂▂▁▁▁▁▁▁

summary
JSON.parse
1.41x faster than ts: codec
2.17x faster than bebop
2.6x faster than msgpackr
4.19x faster than msgpackr + records

• roundtrip
------------------------------------------- -------------------------------
  ts:codec                      19.58 µs / iter  24.03 µs   █
(13.68 µs … 27.52 µs) 26.12 µs   █
(0.00  b …   3.75 kb) 1.08 kb ▇▁█▇▁▁▁▁▁▁▁▁▇▁▇▁▁▇▁▇▇

JSON                           7.85 µs / iter   8.07 µs       █     █
(6.95 µs … 9.00 µs) 8.84 µs       █     █
(0.00  b …   1.78 kb) 0.99 kb ██▁▁██████▁███▁▁▁▁█▁█

msgpackr                      23.93 µs / iter  27.78 µs   █▅▄
(9.73 µs … 389.48 µs) 66.28 µs  ▆████▄▂
(0.00  b … 128.00 kb) 2.72 kb ▄███████▆▅▄▃▃▂▂▂▂▁▁▁▁

msgpackr + records              27.04 µs / iter  31.22 µs   █▅▇▄
(11.68 µs … 926.79 µs) 69.04 µs  ██████▄▂
(0.00  b … 128.00 kb) 2.25 kb ▆████████▇▅▄▃▃▂▂▂▁▁▁▁

bebop                         11.71 µs / iter  11.96 µs         █
(10.34 µs … 13.28 µs) 13.03 µs ▅▅ ▅    █  ▅▅    ▅  ▅
(0.00  b …   7.13 kb) 1.42 kb ██▁█▁▁▁▁█▁▁██▁▁▁▁█▁▁█

summary
JSON
1.49x faster than bebop
2.49x faster than ts: codec
3.05x faster than msgpackr
3.45x faster than msgpackr + records