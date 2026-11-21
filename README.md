# Sokoban Solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Kusuma742/sokoban-solver-01-entry/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Kusuma742/sokoban-solver-01-entry/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver,
21 November 2026" bounty: https://make.fun/bounty/sokoban-solver-01-run-20261121 It answers all 5 instances of a set in one run,
in as few pushes as possible — push-optimal on every level it has been tried
on.

## How it works

A level is a hallway with one to four rooms off it, each room holding 3 or 4
boxes and as many goals, opening onto the hallway through a single door. A box
pushed out of a room into the hallway can never come back, so every box stays
in its room and the level's push-optimal count is the sum of its rooms'
optima. The solver exploits that:

1. **Decompose.** It cuts the dead squares of the player's row (the hallway:
   a box there reaches no goal) out of the floor; each remaining part that
   holds a box is a room.
2. **Solve each room push-optimally with A\*.** A state is the boxes' squares
   plus the player's reachable region. A push costs 1; walking is free. The
   heuristic is the cheapest assignment of boxes to goals by walking
   distance — a lower bound on the pushes still needed, so the search stays
   optimal. Dead states are pruned: a box on a square from which no pull-back
   reaches a goal, and a box frozen in a 2 x 2 block of walls and boxes.
3. **Concatenate.** The rooms are solved in turn, the other rooms' boxes
   standing as walls, the player walking on from where the last room left it.
   If a level is no set of rooms, it falls back to a search over the whole
   level.

Everything is deterministic: fixed direction order, fixed tie-breaking, a
fixed expansion budget counted in states (never the wall clock), no
randomness. Two runs on the same input produce byte-identical output.

## Results

- Practice set: **1,000,000 / 1,000,000** — every instance solved in exactly
  its push-optimal count (i001 13, i002 16, i003 29, i004 47, i005 60).
- 10 freshly drawn sets from the same generator: **1,000,000 on all 10**.
- Runtime: ~0.3 s for a whole set of 5 (limit: 60 s).

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads `/input/<id>/level.txt` (or `MAKEFUN_INPUT_DIR`) and writes
`/output/<id>/solution.txt` (or `MAKEFUN_OUTPUT_DIR`) for each instance, a
string of `u`/`d`/`l`/`r` moves (upper-case marks a push). Node 22, no
dependencies, no network.

## Files

- `main.ts` — the solver
- `README.md` — this file
- `LICENSE` — MIT
