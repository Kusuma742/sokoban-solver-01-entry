// Sokoban solver: push-optimal, room-decomposed A*.
//
// A level is a hallway with one to four rooms off it, each room holding 3 or 4
// boxes and as many goals, opening onto the hallway through a single door. A box
// pushed out of a room into the hallway can never come back, so every box stays
// in its room and the level's push-optimal count is the sum of its rooms'
// optima. This solver exploits that: it cuts the level into rooms, solves each
// room push-optimally on its own, and concatenates the move strings.
//
// Per room it runs A* over push states. A state is the boxes' squares plus the
// player's reachable region (named by its lowest square). The cost of a push is
// 1; walking is free. The heuristic is the cheapest assignment of boxes to
// goals by walking distance (a lower bound on the pushes still needed, since
// one push moves one box one square), which keeps the search optimal. Dead
// states are pruned: a box on a square from which no pull-back reaches a goal,
// and a box frozen in a 2 x 2 block of walls and boxes.
//
// Everything is deterministic: fixed direction order, fixed tie-breaking, a
// fixed expansion budget counted in states (never the wall clock), no
// randomness. Two runs on the same input produce byte-identical output.
//
// Node 22, erasable TypeScript only (no enums, namespaces or parameter
// properties). Runs as: node main.ts, reading MAKEFUN_INPUT_DIR (default
// /input) and writing MAKEFUN_OUTPUT_DIR (default /output).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Four directions in one fixed order: up, down, left, right. Each carries the
// letter for a walk step and the letter for a push step (case is ignored by
// the checker; upper marks a push so the solution stays readable).
const DIRS: ReadonlyArray<readonly [number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// The most states one room search may expand, counted in states, never time.
const MAX_STATES_PER_ROOM = 400_000;
// The most states the whole-level fallback may expand.
const MAX_STATES_GLOBAL = 1_000_000;

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

/** Parse an XSB level: # wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * Live squares: the squares from which a box alone can be pulled back onto
 * some goal. Start from the goals and pull backwards: a square y is live when
 * a box on y can be pulled onto a live square x, which needs the player to be
 * able to stand on the far side (y - d) while the box slides from y to x.
 * A box on a dead square can never reach a goal, so any state holding one is
 * pruned.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The squares the player reaches from `from` around walls and the boxes in
 * `occupied`, marked in `seen` with `stamp`. Returns the lowest square of the
 * region, which names the region in a state's key.
 */
function reach(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    // Neighbours in fixed order so the region is built the same every run.
    const q0 = p - w;
    const q1 = p + w;
    const q2 = p - 1;
    const q3 = p + 1;
    if (wall[q0] === 0 && occupied[q0] === 0 && seen[q0] !== stamp) { seen[q0] = stamp; stack[n++] = q0; }
    if (wall[q1] === 0 && occupied[q1] === 0 && seen[q1] !== stamp) { seen[q1] = stamp; stack[n++] = q1; }
    if (wall[q2] === 0 && occupied[q2] === 0 && seen[q2] !== stamp) { seen[q2] = stamp; stack[n++] = q2; }
    if (wall[q3] === 0 && occupied[q3] === 0 && seen[q3] !== stamp) { seen[q3] = stamp; stack[n++] = q3; }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits frozen in a 2 x 2 block of walls
 * and boxes with a box off its goal. Such a block never moves again, so the
 * state is dead.
 */
function frozenBlock(
  level: Level,
  occupied: Uint8Array,
  goal: Uint8Array,
  t: number,
): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) {
      return true;
    }
  }
  return false;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each part left that
 * holds a box is a room. Returns null when the level is no set of rooms
 * (a box starts in the hallway, a goal is cut off, or a room's boxes and
 * goals do not match).
 */
function roomsOf(level: Level): Array<{ squares: number[]; boxes: number[]; goals: number[] }> | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Array<{ squares: number[]; boxes: number[]; goals: number[] }> = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// All orderings of 0..n-1, built once, for the cheapest box-to-goal matching.
const PERMS_CACHE = new Map<number, number[][]>();
function permutations(n: number): number[][] {
  const cached = PERMS_CACHE.get(n);
  if (cached) return cached;
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const build = (): void => {
    if (cur.length === n) {
      out.push([...cur]);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      build();
      cur.pop();
      used[i] = false;
    }
  };
  build();
  PERMS_CACHE.set(n, out);
  return out;
}

/** Walking distances from every goal to every square, ignoring boxes. dist[g][s] is the fewest steps from s to goal g, or -1. */
function goalDistances(level: Level): Int32Array[] {
  const { w, wall, goals } = level;
  const size = wall.length;
  return goals.map((g) => {
    const dist = new Int32Array(size).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi];
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && dist[q] < 0) {
          dist[q] = dist[p] + 1;
          queue.push(q);
        }
      }
    }
    return dist;
  });
}

/**
 * The cheapest assignment of the boxes to the goals by walking distance: the
 * fewest pushes still needed, since one push moves one box one square. A
 * lower bound, so A* with it stays optimal. Infinity when some box reaches
 * no goal at all (a dead state).
 */
function matchingHeuristic(
  boxes: number[],
  dist: Int32Array[],
  perms: number[][],
): number {
  let best = Infinity;
  for (const p of perms) {
    let sum = 0;
    for (let i = 0; i < boxes.length; i++) {
      const d = dist[p[i]][boxes[i]];
      if (d < 0) {
        sum = Infinity;
        break;
      }
      sum += d;
    }
    if (sum < best) best = sum;
  }
  return best;
}

// A deterministic priority queue: smallest (f, -g, insertion order) first.
type HeapItem = { f: number; g: number; n: number; state: number };
function heapPush(heap: HeapItem[], item: HeapItem): void {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    const a = heap[i];
    const b = heap[parent];
    if (a.f < b.f || (a.f === b.f && (a.g > b.g || (a.g === b.g && a.n < b.n)))) {
      heap[i] = b;
      heap[parent] = a;
      i = parent;
    } else break;
  }
}
function heapPop(heap: HeapItem[]): HeapItem {
  const top = heap[0];
  const last = heap.pop() as HeapItem;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let best = i;
      const less = (x: HeapItem, y: HeapItem): boolean =>
        x.f < y.f || (x.f === y.f && (x.g > y.g || (x.g === y.g && x.n < y.n)));
      if (left < heap.length && less(heap[left], heap[best])) best = left;
      if (right < heap.length && less(heap[right], heap[best])) best = right;
      if (best === i) break;
      const tmp = heap[i];
      heap[i] = heap[best];
      heap[best] = tmp;
      i = best;
    }
  }
  return top;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower-case letters. Empty when already there. */
function walkTo(
  level: Level,
  occupied: Uint8Array,
  from: number,
  to: number,
): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
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
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after `moves` (case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

type SearchResult = { pushes: number; moves: string } | null;

/**
 * A push-optimal solution of `level` (only its `boxes` move; every other
 * box is already a wall in `wall`), searching at most `maxStates` states.
 * A* over push states with the cheapest-assignment heuristic, pruning dead
 * squares and frozen 2 x 2 blocks. Returns null when the search gives up or
 * the level has no solution.
 */
function solvePushOptimal(level: Level, maxStates: number): SearchResult {
  const { w, wall, goals, boxes: startBoxes } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const dist = goalDistances(level);
  const perms = permutations(goals.length);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (startBoxes.some((b) => !live[b])) return null;
  const keyOf = (boxes: number[], low: number): string => `${low}|${boxes.join(',')}`;

  // The states in the order found: their boxes, the player's square after the
  // push that made them, and the push (box moved, direction) from the parent.
  const statesBoxes: number[][] = [startBoxes];
  const statesPlayer: number[] = [level.player];
  const parent: number[] = [-1];
  const pushBox: number[] = [-1];
  const pushDir: number[] = [-1];
  const bestG = new Map<string, number>();
  for (const b of startBoxes) occupied[b] = 1;
  const startLow = reach(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of startBoxes) occupied[b] = 0;
  bestG.set(keyOf(startBoxes, startLow), 0);
  const startH = matchingHeuristic(startBoxes, dist, perms);
  if (startH === Infinity) return null;
  const heap: HeapItem[] = [];
  let counter = 0;
  heapPush(heap, { f: startH, g: 0, n: counter++, state: 0 });
  let found = solved(startBoxes) ? 0 : -1;
  let expanded = 0;

  while (heap.length > 0 && found < 0) {
    const item = heapPop(heap);
    const s = item.state;
    const boxes = statesBoxes[s];
    const g = item.g;
    // A stale heap entry (a better path to this state was found since).
    const low0 = reach(level, (() => { for (const b of boxes) occupied[b] = 1; return occupied; })(), statesPlayer[s], seen, ++stamp, stack);
    for (const b of boxes) occupied[b] = 0;
    if ((bestG.get(keyOf(boxes, low0)) ?? Infinity) < g) continue;
    if (++expanded > maxStates) return null;
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, statesPlayer[s], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di];
        const d = dy * w + dx;
        const t = b + d;
        // The player must stand on b - d to push, the landing square must be
        // open floor, live, and not another box.
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = '';
        let next: number[] | null = null;
        let h = Infinity;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reach(level, occupied, b, mark, ++stamp, stack));
          h = matchingHeuristic(next, dist, perms);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || h === Infinity) continue;
        if ((bestG.get(key) ?? Infinity) <= g + 1) continue;
        bestG.set(key, g + 1);
        const ns = statesBoxes.length;
        statesBoxes.push(next as number[]);
        statesPlayer.push(b);
        parent.push(s);
        pushBox.push(b);
        pushDir.push(di);
        if (solved(next as number[])) {
          found = ns;
          break;
        }
        heapPush(heap, { f: g + 1 + h, g: g + 1, n: counter++, state: ns });
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = startBoxes;
  for (const s of path) {
    const nextBoxes = statesBoxes[s];
    const from = boxes.find((b) => !nextBoxes.includes(b)) as number;
    const to = nextBoxes.find((b) => !boxes.includes(b)) as number;
    const d = to - from;
    const di = pushDir[s];
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS[di][3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's.
 * Falls back to a search over the whole level when the level is no set of
 * rooms, or when a room's search gives up.
 */
function solveLevel(level: Level): SearchResult {
  const rooms = roomsOf(level);
  if (rooms !== null) {
    let player = level.player;
    let pushes = 0;
    let moves = '';
    for (const room of rooms) {
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        // Boxes of a finished room sit on its goals; either way they are walls.
        const done = (other as { done?: boolean }).done === true;
        for (const b of done ? other.goals : other.boxes) wall[b] = 1;
      }
      const sub: Level = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = solvePushOptimal(sub, MAX_STATES_PER_ROOM);
      if (solved === null) return solvePushOptimal(level, MAX_STATES_GLOBAL);
      pushes += solved.pushes;
      moves += solved.moves;
      player = endOf(level.w, player, solved.moves);
      (room as { done?: boolean }).done = true;
    }
    return { pushes, moves };
  }
  return solvePushOptimal(level, MAX_STATES_GLOBAL);
}

/** Solve one level's text into its move string; empty when unsolved (still a valid, answered file). */
function solve(text: string): string {
  const level = parseLevel(text);
  const solved = solveLevel(level);
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solve(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
