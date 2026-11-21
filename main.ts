// Push-optimal Sokoban solver.
//
// The levels this solver faces are built as a hallway with small rooms off
// it, and a box can never be pushed out of the room it starts in — so a
// level's push optimum is the sum of its rooms' optima. The solver splits
// the board at the hallway row (each room is one connected floor region
// off it), solves each room exactly with an A* search over pushes
// (min-cost box-to-goal matching as the heuristic, static dead squares
// pruned), and stitches the rooms together by walking the player between
// pushes. Everything is
// budgeted by expansion counts, never by the clock, so two runs of the
// program on the same set write byte-identical answers.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INPUT_ROOT = "/input";
const OUTPUT_ROOT = "/output";

// Direction tables: 0 = up, 1 = down, 2 = left, 3 = right.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const WALK_LETTER = ["u", "d", "l", "r"];
const PUSH_LETTER = ["U", "D", "L", "R"];

interface Board {
  w: number;
  h: number;
  n: number;
  wall: Uint8Array;
  goal: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Board {
  const lines = text.split(/\r?\n/).filter((line, i, all) => line.length > 0 || i < all.length - 1);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const h = lines.length;
  const w = Math.max(...lines.map((line) => line.length));
  const n = w * h;
  const wall = new Uint8Array(n).fill(1);
  const goal = new Uint8Array(n);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    const line = lines[y];
    for (let x = 0; x < w; x++) {
      const ch = x < line.length ? line[x] : "#";
      const cell = y * w + x;
      if (ch === "#") continue;
      wall[cell] = 0;
      if (ch === "." || ch === "*" || ch === "+") {
        goal[cell] = 1;
        goals.push(cell);
      }
      if (ch === "$" || ch === "*") boxes.push(cell);
      if (ch === "@" || ch === "+") player = cell;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, n, wall, goal, goals, boxes, player };
}

function neighbours(board: Board, cell: number): number[] {
  const x = cell % board.w;
  const y = (cell / board.w) | 0;
  const out: number[] = [];
  for (let d = 0; d < 4; d++) {
    const nx = x + DX[d];
    const ny = y + DY[d];
    if (nx < 0 || ny < 0 || nx >= board.w || ny >= board.h) continue;
    const next = ny * board.w + nx;
    if (!board.wall[next]) out.push(next);
  }
  return out;
}

function stepCell(board: Board, cell: number, dir: number): number {
  const x = cell % board.w;
  const y = (cell / board.w) | 0;
  const nx = x + DX[dir];
  const ny = y + DY[dir];
  if (nx < 0 || ny < 0 || nx >= board.w || ny >= board.h) return -1;
  return ny * board.w + nx;
}

// Squares the player can walk to from `start` without pushing anything;
// `blocked` marks squares occupied by boxes.
function reachMask(board: Board, start: number, blocked: Uint8Array): Uint8Array {
  const seen = new Uint8Array(board.n);
  if (start < 0) return seen;
  const queue = [start];
  seen[start] = 1;
  for (let head = 0; head < queue.length; head++) {
    for (const next of neighbours(board, queue[head])) {
      if (seen[next] || blocked[next]) continue;
      seen[next] = 1;
      queue.push(next);
    }
  }
  return seen;
}

// Shortest walking route from `start` to `target` as LURD letters, or null.
function walkPath(board: Board, start: number, target: number, blocked: Uint8Array): string | null {
  if (start === target) return "";
  const parent = new Int32Array(board.n).fill(-1);
  const parentDir = new Int8Array(board.n).fill(-1);
  const queue = [start];
  parent[start] = start;
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    const x = cell % board.w;
    const y = (cell / board.w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= board.w || ny >= board.h) continue;
      const next = ny * board.w + nx;
      if (board.wall[next] || blocked[next] || parent[next] !== -1) continue;
      parent[next] = cell;
      parentDir[next] = d;
      if (next === target) {
        let letters = "";
        for (let at = target; at !== start; at = parent[at]) {
          letters = WALK_LETTER[parentDir[at]] + letters;
        }
        return letters;
      }
      queue.push(next);
    }
  }
  return null;
}

interface Room {
  cells: Set<number>; // the room's own floor squares
  arena: Set<number>; // squares a box of this room may occupy while solving
  boxes: number[]; // start squares of this room's boxes
  goals: number[]; // goal squares inside the arena
}

// Split the board into rooms. The generator lays a one-square-wide
// hallway across the board on the player's row, with one door into each
// room; a box pushed out of its room can never come back, so each room is
// exactly one connected floor region once the hallway row is removed.
// (Splitting at articulation squares instead fails: a room's own carved
// floor has narrow necks, and a box may start on one.)
function decompose(board: Board): Room[] | null {
  const hallRow = (board.player / board.w) | 0;
  const inHallway = (cell: number) => ((cell / board.w) | 0) === hallRow && !board.wall[cell];
  if (board.boxes.some(inHallway)) return null; // a box starts in the hallway
  const region = new Int32Array(board.n).fill(-1);
  let regionCount = 0;
  for (let cell = 0; cell < board.n; cell++) {
    if (board.wall[cell] || inHallway(cell) || region[cell] !== -1) continue;
    const queue = [cell];
    region[cell] = regionCount;
    for (let head = 0; head < queue.length; head++) {
      for (const next of neighbours(board, queue[head])) {
        if (board.wall[next] || inHallway(next) || region[next] !== -1) continue;
        region[next] = regionCount;
        queue.push(next);
      }
    }
    regionCount++;
  }
  const byRegion = new Map<number, Room>();
  const roomOf = (id: number): Room => {
    let room = byRegion.get(id);
    if (!room) {
      room = { cells: new Set(), arena: new Set(), boxes: [], goals: [] };
      byRegion.set(id, room);
    }
    return room;
  };
  for (let cell = 0; cell < board.n; cell++) {
    if (board.wall[cell] || inHallway(cell)) continue;
    const room = roomOf(region[cell]);
    room.cells.add(cell);
    room.arena.add(cell);
    if (board.goal[cell]) room.goals.push(cell);
  }
  for (const box of board.boxes) {
    const id = region[box];
    if (id === -1) return null;
    roomOf(id).boxes.push(box);
  }
  const rooms = [...byRegion.values()].filter((room) => room.boxes.length > 0);
  for (const room of rooms) {
    if (room.goals.length < room.boxes.length) return null;
    room.boxes.sort((a, b) => a - b);
    room.goals.sort((a, b) => a - b);
  }
  rooms.sort((a, b) => Math.min(...a.boxes) - Math.min(...b.boxes));
  return rooms;
}

// Push distance from every arena square to one goal, counting pushes and
// ignoring the other boxes: a box steps one square when the square behind
// it is floor the player could stand on.
function pushDistances(board: Board, arena: Set<number>, goalCell: number): Int32Array {
  const dist = new Int32Array(board.n).fill(-1);
  const queue = [goalCell];
  dist[goalCell] = 0;
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head];
    for (let d = 0; d < 4; d++) {
      const before = stepCell(board, at, d ^ 1); // box came from here
      if (before < 0 || !arena.has(before) || dist[before] !== -1) continue;
      const stand = stepCell(board, before, d ^ 1); // player stood here
      if (stand < 0 || board.wall[stand]) continue;
      dist[before] = dist[at] + 1;
      queue.push(before);
    }
  }
  return dist;
}

// Min-cost assignment of boxes to goals over the push-distance tables.
// Small rooms (up to 5 boxes) are matched exactly by permutation; larger
// ones fall back to the sum of each box's nearest goal, still admissible.
function matchingBound(distTables: Int32Array[], boxes: number[]): number {
  const k = boxes.length;
  if (k === 0) return 0;
  if (k > 5 || distTables.length > 8) {
    let sum = 0;
    for (const box of boxes) {
      let best = Infinity;
      for (const table of distTables) {
        if (table[box] >= 0) best = Math.min(best, table[box]);
      }
      if (best === Infinity) return Infinity;
      sum += best;
    }
    return sum;
  }
  const used = new Uint8Array(distTables.length);
  let bestTotal = Infinity;
  const walk = (i: number, acc: number) => {
    if (acc >= bestTotal) return;
    if (i === k) {
      bestTotal = acc;
      return;
    }
    for (let g = 0; g < distTables.length; g++) {
      if (used[g]) continue;
      const cost = distTables[g][boxes[i]];
      if (cost < 0) continue;
      used[g] = 1;
      walk(i + 1, acc + cost);
      used[g] = 0;
    }
  };
  walk(0, 0);
  return bestTotal;
}

interface PushStep {
  boxFrom: number;
  dir: number;
}

interface SearchNode {
  boxes: number[];
  player: number;
  g: number;
  f: number;
  seq: number;
  parent: SearchNode | null;
  step: PushStep | null;
}

// A binary heap ordered by f, then by greater depth, then by arrival.
class NodeHeap {
  private items: SearchNode[] = [];
  private before(a: SearchNode, b: SearchNode): boolean {
    if (a.f !== b.f) return a.f < b.f;
    if (a.g !== b.g) return a.g > b.g;
    return a.seq < b.seq;
  }
  get size(): number {
    return this.items.length;
  }
  push(node: SearchNode) {
    const items = this.items;
    items.push(node);
    for (let i = items.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (!this.before(items[i], items[p])) break;
      [items[i], items[p]] = [items[p], items[i]];
      i = p;
    }
  }
  pop(): SearchNode | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && this.before(items[l], items[m])) m = l;
        if (r < items.length && this.before(items[r], items[m])) m = r;
        if (m === i) break;
        [items[i], items[m]] = [items[m], items[i]];
        i = m;
      }
    }
    return top;
  }
}

// Solve one room push-optimally. `foreign` marks squares held by other
// rooms' boxes; they are fixed obstacles. Returns the push list, or null
// when the expansion budget runs out.
function solveRoom(
  board: Board,
  room: Room,
  startBoxes: number[],
  startPlayer: number,
  foreign: Uint8Array,
  expansionCap: number,
): PushStep[] | null {
  const distTables = room.goals.map((g) => pushDistances(board, room.arena, g));
  const live = new Uint8Array(board.n);
  for (const table of distTables) {
    for (let cell = 0; cell < board.n; cell++) if (table[cell] >= 0) live[cell] = 1;
  }
  const startBound = matchingBound(distTables, startBoxes);
  if (startBound === Infinity) return null;

  const heap = new NodeHeap();
  const bestG = new Map<string, number>();
  let seq = 0;
  const root: SearchNode = {
    boxes: [...startBoxes].sort((a, b) => a - b),
    player: startPlayer,
    g: 0,
    f: startBound,
    seq: seq++,
    parent: null,
    step: null,
  };
  heap.push(root);
  let expansions = 0;

  const keyOf = (boxes: number[], reach: Uint8Array): string => {
    let rep = -1;
    for (let cell = 0; cell < board.n; cell++) {
      if (reach[cell]) {
        rep = cell;
        break;
      }
    }
    return boxes.join(",") + "|" + rep;
  };

  while (heap.size > 0) {
    const node = heap.pop()!;
    if (node.boxes.every((box) => board.goal[box])) {
      const steps: PushStep[] = [];
      for (let at: SearchNode | null = node; at && at.step; at = at.parent) {
        steps.push(at.step);
      }
      return steps.reverse();
    }
    if (++expansions > expansionCap) return null;

    const blocked = new Uint8Array(foreign);
    for (const box of node.boxes) blocked[box] = 1;
    const reach = reachMask(board, node.player, blocked);
    const key = keyOf(node.boxes, reach);
    if (bestG.has(key) && bestG.get(key)! <= node.g) continue;
    bestG.set(key, node.g);

    for (let i = 0; i < node.boxes.length; i++) {
      const box = node.boxes[i];
      for (let d = 0; d < 4; d++) {
        const target = stepCell(board, box, d);
        if (target < 0 || !room.arena.has(target)) continue;
        if (board.wall[target] || blocked[target] || !live[target]) continue;
        const stand = stepCell(board, box, d ^ 1);
        if (stand < 0 || board.wall[stand] || blocked[stand] || !reach[stand]) continue;
        const nextBoxes = [...node.boxes];
        nextBoxes[i] = target;
        nextBoxes.sort((a, b) => a - b);
        const bound = matchingBound(distTables, nextBoxes);
        if (bound === Infinity) continue;
        heap.push({
          boxes: nextBoxes,
          player: box,
          g: node.g + 1,
          f: node.g + 1 + bound,
          seq: seq++,
          parent: node,
          step: { boxFrom: box, dir: d },
        });
      }
    }
  }
  return null;
}

// Replay a move string on a fresh copy of the level; returns the final
// box squares and player square, or null on an illegal step.
function replay(board: Board, moves: string): { boxes: number[]; player: number } | null {
  const boxes = new Set(board.boxes);
  let player = board.player;
  for (const ch of moves) {
    const d = WALK_LETTER.indexOf(ch.toLowerCase());
    if (d === -1) continue;
    const next = stepCell(board, player, d);
    if (next < 0 || board.wall[next]) return null;
    if (boxes.has(next)) {
      const beyond = stepCell(board, next, d);
      if (beyond < 0 || board.wall[beyond] || boxes.has(beyond)) return null;
      boxes.delete(next);
      boxes.add(beyond);
    }
    player = next;
  }
  return { boxes: [...boxes].sort((a, b) => a - b), player };
}

// Last-resort whole-board search (greedy best-first over pushes with the
// sum-of-nearest-goals bound). Only used if the room split ever fails.
function solveWholeBoard(board: Board): string {
  const arena = new Set<number>();
  for (let cell = 0; cell < board.n; cell++) if (!board.wall[cell]) arena.add(cell);
  const room: Room = { cells: arena, arena, boxes: [...board.boxes], goals: [...board.goals] };
  const foreign = new Uint8Array(board.n);
  const steps = solveRoom(board, room, board.boxes, board.player, foreign, 300_000);
  if (!steps) return "";
  return realiseSteps(board, steps, board.boxes, board.player) ?? "";
}

// Turn a push list into the full move string, walking the player to each
// push position. Returns null if a walk is impossible.
function realiseSteps(
  board: Board,
  steps: PushStep[],
  startBoxes: number[],
  startPlayer: number,
): string | null {
  const boxes = new Set(startBoxes);
  let player = startPlayer;
  let out = "";
  for (const step of steps) {
    if (!boxes.has(step.boxFrom)) return null;
    const stand = stepCell(board, step.boxFrom, step.dir ^ 1);
    const blocked = new Uint8Array(board.n);
    for (const box of boxes) blocked[box] = 1;
    const walk = walkPath(board, player, stand, blocked);
    if (walk === null) return null;
    out += walk + PUSH_LETTER[step.dir];
    const target = stepCell(board, step.boxFrom, step.dir);
    boxes.delete(step.boxFrom);
    boxes.add(target);
    player = step.boxFrom;
  }
  return out;
}

function solveLevel(text: string): string {
  const board = parseLevel(text);
  if (board.boxes.every((box) => board.goal[box])) return "";
  const rooms = decompose(board);
  if (!rooms) return solveWholeBoard(board);

  // Current squares of each room's boxes, by room. A room's boxes never
  // leave it, and an unsolved room's boxes still sit on their start
  // squares, so this bookkeeping stays exact as rooms are solved in turn.
  const roomBoxes: number[][] = rooms.map((room) => [...room.boxes]);

  let boxes = [...board.boxes];
  let player = board.player;
  let out = "";
  for (let idx = 0; idx < rooms.length; idx++) {
    const room = rooms[idx];
    const mine = new Set(roomBoxes[idx]);
    const foreign = new Uint8Array(board.n);
    for (const box of boxes) if (!mine.has(box)) foreign[box] = 1;
    const steps =
      solveRoom(board, room, roomBoxes[idx], player, foreign, 600_000) ??
      solveRoom(board, room, roomBoxes[idx], player, foreign, 3_000_000);
    if (!steps) return solveWholeBoard(board);
    const realised = realiseSteps(board, steps, boxes, player);
    if (realised === null) return solveWholeBoard(board);
    out += realised;
    const after = replay(board, out);
    if (!after) return solveWholeBoard(board);
    boxes = after.boxes;
    player = after.player;
    roomBoxes[idx] = after.boxes.filter((box) => room.goals.includes(box));
  }
  const done = replay(board, out);
  if (!done || !done.boxes.every((box) => board.goal[box])) return solveWholeBoard(board);
  return out;
}

function main(): void {
  const ids = readdirSync(INPUT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const id of ids) {
    const levelText = readFileSync(join(INPUT_ROOT, id, "level.txt"), "utf8");
    const answer = solveLevel(levelText);
    const dir = join(OUTPUT_ROOT, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "solution.txt"), answer, "utf8");
  }
}

main();
