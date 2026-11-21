# Sokoban Solver — push-optimal

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/beecoder77/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/beecoder77/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's `sokoban-solver-01-run-20261121`
bounty: one run of `node main.ts` answers all 5 instances of a set, in as few
pushes as possible. Practice score **1,000,000** (push-optimal on all 5 practice
instances), and 1,000,000 on 10 further sets drawn independently with the kit's
own generator.

## How it works

Scoring is by pushes, and a level's push optimum is the sum of its rooms'
optima: a box pushed out of its room through its door can never come back, so
rooms are independent subproblems. The solver:

1. **Splits the level into rooms** — the player starts in a one-wide hallway,
   and every floor square of the hallway row is dead (a box there reaches no
   goal), so cutting those squares out of the floor leaves each room as its own
   connected part.
2. **Solves each room push-optimally** with A* over pushes: a state is the
   sorted box squares plus the player's reachable region (named by its lowest
   square). The heuristic is the minimum-cost assignment of boxes to goals
   over shortest-path step distances — admissible, since one push moves one
   box one square. Deadlock pruning: boxes may only stand on live squares
   (reachable back to a goal by pulls), and pushes into frozen 2×2 blocks of
   walls and boxes are refused.
3. **Walks between rooms** through the hallway — walks push nothing, so they
   cost no points — and verifies the full move string by replay before writing
   it. A whole-level search is the fallback; an empty (valid, unscored) answer
   is the last resort, never an illegal one.

Budgets are by work (state expansions), never by the wall clock: no clock reads,
no randomness, so two runs answer byte for byte alike. The whole practice set
solves in ~0.3 s on this VM, far inside the 60 s budget.

## Local grading

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## License

MIT — see [LICENSE](LICENSE).
