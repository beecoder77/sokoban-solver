// sokoban-solver — a push-optimal Sokoban solver for make.fun's sokoban-solver-01.
//
// Design (written from scratch for this entry):
// - Scoring is by PUSHES, not moves, and a level's push optimum P* is the sum of
//   its rooms' optima: a box pushed out of its room through its door can never come
//   back, so rooms are independent subproblems. Each room is solved push-optimally
//   on its own (other rooms' boxes standing as walls), and the player walks between
//   rooms through the hallway — walks push nothing, so they cost no points.
// - Each room is solved with A* over PUSHES: a state is the sorted box squares plus
//   the player's reachable region (named by its lowest square). The heuristic is the
//   minimum-cost assignment of boxes to goals over shortest-path step distances
//   (exact for up to 5 boxes, by enumerating permutations); every push moves one box
//   one square, so the assignment cost is an admissible lower bound on pushes left.
// - Deadlock pruning: a box may only ever stand on a "live" square (one from which
//   a lone box can be pulled back onto some goal), and a push that leaves a box in a
//   frozen 2x2 block of walls and boxes (a box off its goal among them) is refused.
// - Budgets are by WORK (state expansions), never by the wall clock, so two runs
//   answer byte for byte alike. No clock, no randomness, no environment reads that
//   could vary an answer.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets only — never the wall clock, so two runs answer alike.
const ROOM_EXPANSIONS = 500_000;
const FALLBACK_EXPANSIONS = 200_000;
const TOTAL_EXPANSIONS = 2_000_000;

// The four steps, always in this order, so every tie breaks the same way.
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/**
 * A level in XSB text. The board is padded with one ring of walls, so no neighbour
 * lookup ever leaves the array: short rows pad as walls, the outer frame is a wall
 * whatever it shows.
 */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const rh = rows.length;
  const rw = Math.max(...rows.map((r) => r.length));
  const w = rw + 2;
  const h = rh + 2;
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = (y + 1) * w + (x + 1);
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares a lone box can stand on and still reach some goal: pull the goals
 * backwards — a box pushed from y to x = y + d stood with the player at y - d, so
 * y is live when x is live and both y and y - d are open floor.
 */
function liveSquares(wall: Uint8Array, goals: number[], w: number): Uint8Array {
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (live[y] || wall[y] || wall[y - d]) continue;
      live[y] = 1;
      queue.push(y);
    }
  }
  return live;
}

/** Shortest-path step distances from `from` over open floor (walls only). */
function bfsDist(wall: Uint8Array, from: number, w: number): Int32Array {
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || dist[q] !== -1) continue;
      dist[q] = dist[p]! + 1;
      queue.push(q);
    }
  }
  return dist;
}

/** All orderings of n items, for the exact box-to-goal assignment (n <= 5). */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const a = Array.from({ length: n }, (_, i) => i);
  const gen = (k: number): void => {
    if (k === n) {
      out.push(a.slice());
      return;
    }
    for (let i = k; i < n; i++) {
      [a[k], a[i]] = [a[i]!, a[k]!];
      gen(k + 1);
      [a[k], a[i]] = [a[i]!, a[k]!];
    }
  };
  gen(0);
  return out;
}
const PERMS: Record<number, number[][]> = {
  1: [[0]],
  2: permutations(2),
  3: permutations(3),
  4: permutations(4),
  5: permutations(5),
};

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four squares of
 * walls and boxes, one of the boxes off its goal. No box in such a block can ever
 * be pushed again, so the state is dead.
 */
function frozenAt(wall: Uint8Array, occupied: Uint8Array, goal: Uint8Array, t: number, w: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!((wall[a] || occupied[a]) && (wall[b] || occupied[b]) && (wall[c] || occupied[c]) && (wall[d] || occupied[d]))) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD. */
function walkTo(wall: Uint8Array, occupied: Uint8Array, from: number, to: number, w: number): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The player's square after playing `moves` (every letter steps the player once). */
function applyMoves(from: number, moves: string, w: number): number {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * Push-optimal A* for one (sub-)level: the fewest pushes that put every box on a
 * goal, or null when the work budget runs out (or no solution exists). States are
 * the boxes plus the player's reachable region; pushes are the only moves.
 */
function solvePushes(
  wall: Uint8Array,
  goals: number[],
  boxes0: number[],
  player0: number,
  w: number,
  budget: { used: number; limit: number },
  cap: number,
): { pushes: number; moves: string } | null {
  const size = wall.length;
  const n = boxes0.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(wall, goals, w);
  for (const b of boxes0) if (!live[b]) return null;
  const distTo = goals.map((g) => bfsDist(wall, g, w));
  const isSolved = (bs: number[]): boolean => bs.every((b) => goal[b] === 1);
  if (isSolved(boxes0)) return { pushes: 0, moves: '' };

  // Admissible estimate: the cheapest way to match boxes to goals by step distance
  // (exact assignment for n <= 5; sum of nearest-goal distances beyond that).
  // One push moves one box one square, so no solution finishes in fewer pushes.
  const perms = PERMS[n] ?? null;
  const heuristic = (bs: number[]): number => {
    if (perms) {
      let best = Infinity;
      for (const p of perms) {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const d = distTo[p[i]!]![bs[i]!]!;
          if (d < 0) {
            s = Infinity;
            break;
          }
          s += d;
        }
        if (s < best) best = s;
      }
      return best;
    }
    let s = 0;
    for (const b of bs) {
      let m = Infinity;
      for (const dt of distTo) {
        const d = dt[b]!;
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      s += m;
    }
    return s;
  };

  // The states, in order found: their boxes, the player's square after the push
  // that made them, and the push that made them from their parent.
  const boxStates: number[][] = [boxes0.slice()];
  const playerStates: number[] = [player0];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushDir: number[] = [-1];
  const gScore: number[] = [0];

  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  const occupied = new Uint8Array(size);
  let stamp = 0;
  let markStamp = 0;

  // Flood the player's reachable region from `from` (boxes as obstacles) and name
  // it by its lowest square — the state's canonical player representative. It
  // marks its own array: the expansion's region marks in `seen` must survive the
  // successors this state generates, so the two floods never share stamps.
  const regionLow = (from: number): number => {
    const st = ++markStamp;
    let low = from;
    let sp = 0;
    stack[sp++] = from;
    mark[from] = st;
    while (sp > 0) {
      const p = stack[--sp]!;
      if (p < low) low = p;
      const q0 = p - w;
      if (!wall[q0] && !occupied[q0] && mark[q0] !== st) {
        mark[q0] = st;
        stack[sp++] = q0;
      }
      const q1 = p + w;
      if (!wall[q1] && !occupied[q1] && mark[q1] !== st) {
        mark[q1] = st;
        stack[sp++] = q1;
      }
      const q2 = p - 1;
      if (!wall[q2] && !occupied[q2] && mark[q2] !== st) {
        mark[q2] = st;
        stack[sp++] = q2;
      }
      const q3 = p + 1;
      if (!wall[q3] && !occupied[q3] && mark[q3] !== st) {
        mark[q3] = st;
        stack[sp++] = q3;
      }
    }
    return low;
  };

  const keyOf = (bs: number[], low: number): number | string => {
    if (n <= 5) {
      let k = low;
      for (const b of bs) k = k * size + b;
      return k;
    }
    return `${low}:${bs.join(',')}`;
  };

  for (const b of boxes0) occupied[b] = 1;
  const best = new Map<number | string, number>([[keyOf(boxes0, regionLow(player0)), 0]]);
  for (const b of boxes0) occupied[b] = 0;

  // A heap on [f, -g, index]: fewest pushes + estimate first, deeper first on ties,
  // earliest found first after that — fully deterministic.
  const heap: [number, number, number][] = [];
  const heapLess = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  const h0 = heuristic(boxes0);
  if (h0 === Infinity) return null;
  heapPush([h0, 0, 0]);

  let expansions = 0;
  let found = -1;
  while (heap.length > 0) {
    const [, negG, s] = heapPop();
    if (-negG !== gScore[s]!) continue; // a better path to this state superseded it
    const bs = boxStates[s]!;
    if (isSolved(bs)) {
      found = s;
      break;
    }
    expansions++;
    budget.used++;
    if (expansions > cap || budget.used > budget.limit) return null;
    const g = gScore[s]!;
    for (const b of bs) occupied[b] = 1;
    // The player's reachable region from where this state left them.
    const here = ++stamp;
    let sp = 0;
    stack[sp++] = playerStates[s]!;
    seen[playerStates[s]!] = here;
    while (sp > 0) {
      const p = stack[--sp]!;
      const q0 = p - w;
      if (!wall[q0] && !occupied[q0] && seen[q0] !== here) {
        seen[q0] = here;
        stack[sp++] = q0;
      }
      const q1 = p + w;
      if (!wall[q1] && !occupied[q1] && seen[q1] !== here) {
        seen[q1] = here;
        stack[sp++] = q1;
      }
      const q2 = p - 1;
      if (!wall[q2] && !occupied[q2] && seen[q2] !== here) {
        seen[q2] = here;
        stack[sp++] = q2;
      }
      const q3 = p + 1;
      if (!wall[q3] && !occupied[q3] && seen[q3] !== here) {
        seen[q3] = here;
        stack[sp++] = q3;
      }
    }
    for (let bi = 0; bi < n; bi++) {
      const b = bs[bi]!;
      for (let d = 0; d < 4; d++) {
        const [dx, dy] = DIRS[d]!;
        const step = dy * w + dx;
        const t = b + step;
        if (wall[t] || occupied[t] || !live[t]) continue;
        if (seen[b - step] !== here) continue; // the player cannot stand to push
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenAt(wall, occupied, goal, t, w)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = bs.slice();
        next[bi] = t;
        next.sort((a, z) => a - z);
        const key = keyOf(next, regionLow(b));
        const prev = best.get(key);
        if (prev === undefined) {
          const idx = boxStates.length;
          boxStates.push(next);
          playerStates.push(b);
          parent.push(s);
          pushFrom.push(b);
          pushDir.push(d);
          gScore.push(g + 1);
          best.set(key, idx);
          const h = heuristic(next);
          if (h < Infinity) heapPush([g + 1 + h, -(g + 1), idx]);
        } else if (g + 1 < gScore[prev]!) {
          parent[prev] = s;
          pushFrom[prev] = b;
          pushDir[prev] = d;
          gScore[prev] = g + 1;
          const h = heuristic(next);
          if (h < Infinity) heapPush([g + 1 + h, -(g + 1), prev]);
        }
        occupied[t] = 0;
        occupied[b] = 1;
      }
    }
    for (const b of bs) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of pushes, then the moves: walk to each push's square, then push.
  const chain: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = player0;
  let boxes = boxes0.slice();
  for (const s of chain) {
    const from = pushFrom[s]!;
    const d = pushDir[s]!;
    const [dx, dy, , pushLetter] = DIRS[d]!;
    const step = dy * w + dx;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(wall, occupied, player, from - step, w);
    for (const b of boxes) occupied[b] = 0;
    moves += pushLetter;
    player = from;
    boxes = boxStates[s]!.slice();
  }
  return { pushes: chain.length, moves };
}

interface Room {
  boxes: number[];
  goals: number[];
}

/**
 * The level's rooms: the player starts in a one-wide hallway, and every floor
 * square of that hallway row is dead — a box there reaches no goal — so cutting
 * those squares out of the floor leaves each room as its own connected part.
 * Null when the level is no set of rooms (a box in the hallway, or a part whose
 * boxes and goals do not match).
 */
function decomposeRooms(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const size = wall.length;
  const live = liveSquares(wall, goals, w);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(size);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const comp = new Int32Array(size).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || comp[s] >= 0) continue;
    const squares = [s];
    comp[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && !cut[q] && comp[q] < 0) {
          comp[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [] });
  }
  for (const b of boxes) {
    const c = comp[b]!;
    if (c < 0) return null;
    rooms[c]!.boxes.push(b);
  }
  for (const g of goals) {
    const c = comp[g]!;
    if (c < 0) return null;
    rooms[c]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Replay `moves` on the level: true only when it is legal and solves the level. */
function replaySolved(level: Level, moves: string): boolean {
  const { w, wall, goals } = level;
  const goal = new Uint8Array(wall.length);
  for (const g of goals) goal[g] = 1;
  const boxes = new Set(level.boxes);
  let p = level.player;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    if (c !== 'u' && c !== 'd' && c !== 'l' && c !== 'r') return false;
    const d = c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
    const q = p + d;
    if (wall[q]) return false;
    if (boxes.has(q)) {
      const t = q + d;
      if (wall[t] || boxes.has(t)) return false;
      boxes.delete(q);
      boxes.add(t);
    }
    p = q;
  }
  return [...boxes].every((b) => goal[b] === 1);
}

/**
 * One level's moves: room by room in scan order, each room push-optimal on a board
 * where the other rooms' boxes stand as walls (on their goals once solved, on their
 * start squares while unsolved). Falls back to a whole-level search, and to an
 * empty (valid, unscored) answer when nothing solves it — never an illegal one.
 */
function solveLevel(text: string, budget: { used: number; limit: number }): string {
  const level = parseLevel(text);
  const rooms = decomposeRooms(level);
  if (rooms !== null) {
    const solvedFlags = rooms.map(() => false);
    let moves = '';
    let player = level.player;
    let ok = true;
    for (let ri = 0; ri < rooms.length; ri++) {
      const room = rooms[ri]!;
      const wall = level.wall.slice();
      for (let oj = 0; oj < rooms.length; oj++) {
        if (oj === ri) continue;
        const other = rooms[oj]!;
        const squares = solvedFlags[oj] ? other.goals : other.boxes;
        for (const s of squares) wall[s] = 1;
      }
      const res = solvePushes(wall, room.goals, room.boxes, player, level.w, budget, ROOM_EXPANSIONS);
      if (res === null) {
        ok = false;
        break;
      }
      moves += res.moves;
      player = applyMoves(player, res.moves, level.w);
      solvedFlags[ri] = true;
    }
    if (ok && replaySolved(level, moves)) return moves;
  }
  const res = solvePushes(level.wall, level.goals, level.boxes, level.player, level.w, budget, FALLBACK_EXPANSIONS);
  if (res !== null && replaySolved(level, res.moves)) return res.moves;
  return '';
}

const budget = { used: 0, limit: TOTAL_EXPANSIONS };
for (const id of readdirSync(INPUT).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT, id, 'level.txt'), 'utf8'), budget);
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}
