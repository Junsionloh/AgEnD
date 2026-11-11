| prompt | run | summaries | API calls | input | output | cache write | cache read | thinking blocks (text chars) | tool calls | time (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| intervals | r1 | off | 1 | 2 | 185 | 6880 | 14963 | 0 (0) | 0 | 1.8 |
| intervals | r1 | on | 1 | 2 | 218 | 8614 | 15457 | 0 (0) | 0 | 2.0 |
| intervals | r2 | off | 1 | 2 | 186 | 0 | 21843 | 0 (0) | 0 | 2.0 |
| intervals | r2 | on | 1 | 2 | 220 | 0 | 24071 | 0 (0) | 0 | 1.9 |
| notes | r1 | off | 2 | 4 | 192 | 10858 | 41628 | 0 (0) | 1 | 3.2 |
| notes | r1 | on | 2 | 4 | 199 | 11608 | 39031 | 0 (0) | 1 | 3.0 |
| notes | r2 | off | 2 | 4 | 227 | 0 | 50639 | 0 (0) | 1 | 3.3 |
| notes | r2 | on | 2 | 4 | 197 | 11104 | 37294 | 0 (0) | 1 | 3.1 |
| puzzle | r1 | off | 1 | 2 | 434 | 10914 | 13200 | 1 (0) | 0 | 4.0 |
| puzzle | r1 | on | 1 | 2 | 483 | 0 | 24114 | 1 (661) | 0 | 4.8 |
| puzzle | r2 | off | 1 | 2 | 412 | 0 | 24114 | 1 (0) | 0 | 3.9 |
| puzzle | r2 | on | 1 | 2 | 422 | 0 | 24114 | 1 (571) | 0 | 4.5 |
| tiling | r1 | off | 1 | 2 | 173 | 6386 | 15468 | 0 (0) | 0 | 2.0 |
| tiling | r1 | on | 1 | 2 | 163 | 11225 | 14963 | 0 (0) | 0 | 1.7 |
| tiling | r2 | off | 1 | 2 | 172 | 8614 | 15468 | 0 (0) | 0 | 1.8 |
| tiling | r2 | on | 1 | 2 | 173 | 0 | 21854 | 0 (0) | 0 | 2.5 |

| prompt | summaries | runs | input | output | cache write | cache read | thinking blocks (text chars) |
|---|---|---|---|---|---|---|---|
| intervals | off | 2 | 4 | 371 | 6880 | 36806 | 0 (0) |
| intervals | on | 2 | 4 | 438 | 8614 | 39528 | 0 (0) |
| notes | off | 2 | 8 | 419 | 10858 | 92267 | 0 (0) |
| notes | on | 2 | 8 | 396 | 22712 | 76325 | 0 (0) |
| puzzle | off | 2 | 4 | 846 | 10914 | 37314 | 2 (0) |
| puzzle | on | 2 | 4 | 905 | 0 | 48228 | 2 (1232) |
| tiling | off | 2 | 4 | 345 | 15000 | 30936 | 0 (0) |
| tiling | on | 2 | 4 | 336 | 11225 | 36817 | 0 (0) |
| **all** | off | 8 | 20 | 1981 | 43652 | 197323 | 2 (0) |
| **all** | on | 8 | 20 | 2075 | 42551 | 200898 | 2 (1232) |
