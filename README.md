# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Akhmad045/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Akhmad045/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver. The levels are a hallway with small rooms
off it, and a box can never be pushed out of the room it starts in, so a
level's push optimum is the sum of its rooms' optima. The solver splits
the board at the hallway row, solves each room exactly with an A* search
over pushes (min-cost box-to-goal matching as the heuristic, static dead
squares pruned), and stitches the rooms together by walking the player
between pushes. All budgets are expansion counts, never the clock, so
runs are byte-for-byte deterministic. On the kit's practice set it finds
the known optimum on every instance (13, 16, 29, 47 and 60 pushes) in
about a quarter of a second for the whole set.

## Run it

```sh
node main.ts   # reads /input/<id>/level.txt, writes /output/<id>/solution.txt
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=4g7knchf&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
