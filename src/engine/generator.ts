/**
 * Procedural problem generation via Abstract Syntax Trees.
 *
 * Interior nodes are operators, leaves are operands. A template instantiates a
 * constrained tree for a target difficulty band; the constraints are what keep
 * problems solvable, unambiguous, and — critically for this build — *sayable*.
 *
 * Speech changes the constraint set in ways a typing game never had to care
 * about:
 *   - Answers must be integers. "0.43" is not a thing anyone says mid-arcade,
 *     and the old fraction/decimal generators produced exactly that.
 *   - Answers must be non-negative by default. "negative twelve" is two tokens
 *     and a mishear waiting to happen.
 *   - Answers stay small enough to say in one breath.
 *   - No two blocks on screen may share an answer, or a single utterance is
 *     ambiguous between targets.
 *
 * Difficulty is rated on the Elo scale so the adaptive engine can request "an
 * item near 1240" and get one. Ratings drift with real player data (see
 * adaptive.ts) rather than staying pinned to these hand-authored priors.
 */

import { Rng } from './rng';

export type Skill = 'add' | 'sub' | 'mul' | 'div' | 'pow';

export type Node =
  | { k: 'n'; v: number }
  | { k: 'op'; op: '+' | '-' | '*' | '/'; l: Node; r: Node }
  | { k: 'sq'; l: Node }
  | { k: 'sqrt'; v: number };

export interface Item {
  text: string;
  answer: number;
  skill: Skill;
  templateId: string;
  /** Item difficulty on the Elo scale. */
  rating: number;
}

const n = (v: number): Node => ({ k: 'n', v });
const op = (o: '+' | '-' | '*' | '/', l: Node, r: Node): Node => ({ k: 'op', op: o, l, r });

export function evalNode(node: Node): number {
  switch (node.k) {
    case 'n':
      return node.v;
    case 'sq':
      return evalNode(node.l) ** 2;
    case 'sqrt':
      return Math.sqrt(node.v);
    case 'op': {
      const a = evalNode(node.l);
      const b = evalNode(node.r);
      switch (node.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
      }
    }
  }
}

const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };

/** Renders the tree with the minimum parentheses needed to stay unambiguous. */
export function renderNode(node: Node, parentPrec = 0): string {
  switch (node.k) {
    case 'n':
      return String(node.v);
    case 'sq':
      return `${renderNode(node.l, 3)}²`;
    case 'sqrt':
      return `√${node.v}`;
    case 'op': {
      const prec = PREC[node.op];
      const sym = node.op === '*' ? '×' : node.op === '/' ? '÷' : node.op === '-' ? '−' : '+';
      const body = `${renderNode(node.l, prec)} ${sym} ${renderNode(node.r, prec)}`;
      return prec < parentPrec ? `(${body})` : body;
    }
  }
}

/**
 * Number of column carries in a + b. Carries drive working-memory load far
 * more than raw operand magnitude does, so they are priced into difficulty
 * separately.
 */
export function carryCount(a: number, b: number): number {
  let c = 0;
  let carry = 0;
  while (a > 0 || b > 0) {
    const s = (a % 10) + (b % 10) + carry;
    if (s >= 10) { c++; carry = 1; } else carry = 0;
    a = Math.floor(a / 10);
    b = Math.floor(b / 10);
  }
  return c;
}

/** Number of column borrows in a - b (assumes a >= b). */
export function borrowCount(a: number, b: number): number {
  let c = 0;
  let borrow = 0;
  while (a > 0 || b > 0) {
    const d = (a % 10) - (b % 10) - borrow;
    if (d < 0) { c++; borrow = 1; } else borrow = 0;
    a = Math.floor(a / 10);
    b = Math.floor(b / 10);
  }
  return c;
}

interface Draft {
  ast: Node;
  /** Difficulty adjustment within the template, from carries/magnitude/etc. */
  bump?: number;
}

interface Template {
  id: string;
  skill: Skill;
  /** Prior difficulty on the Elo scale. */
  base: number;
  gen: (r: Rng) => Draft;
}

/** Picks a, b in range such that a + b produces exactly `want` carries. */
function addWithCarries(r: Rng, lo: number, hi: number, want: 'none' | 'some'): [number, number] {
  for (let i = 0; i < 40; i++) {
    const a = r.int(lo, hi);
    const b = r.int(lo, hi);
    const c = carryCount(a, b);
    if (want === 'none' && c === 0) return [a, b];
    if (want === 'some' && c > 0) return [a, b];
  }
  return [r.int(lo, hi), r.int(lo, hi)];
}

function subWithBorrows(r: Rng, lo: number, hi: number, want: 'none' | 'some'): [number, number] {
  for (let i = 0; i < 40; i++) {
    let a = r.int(lo, hi);
    let b = r.int(lo, hi);
    if (b > a) [a, b] = [b, a];
    if (a === b) continue;
    const c = borrowCount(a, b);
    if (want === 'none' && c === 0) return [a, b];
    if (want === 'some' && c > 0) return [a, b];
  }
  const a = r.int(lo, hi);
  const b = r.int(lo, Math.max(lo, a));
  return [Math.max(a, b), Math.min(a, b)];
}

/**
 * The template library, spanning roughly 700-2000 Elo.
 *
 * Division templates always build the dividend as quotient x divisor so the
 * result is a whole number by construction — the alternative is generating a
 * fraction and hoping, which is how the old generator ended up asking players
 * to say "0.43".
 */
export const TEMPLATES: Template[] = [
  {
    id: 'add_1d', skill: 'add', base: 700,
    gen: (r) => { const [a, b] = addWithCarries(r, 1, 9, 'none'); return { ast: op('+', n(a), n(b)) }; },
  },
  {
    id: 'add_1d_carry', skill: 'add', base: 830,
    gen: (r) => { const [a, b] = addWithCarries(r, 2, 9, 'some'); return { ast: op('+', n(a), n(b)) }; },
  },
  {
    id: 'sub_1d', skill: 'sub', base: 790,
    gen: (r) => { const a = r.int(5, 18); const b = r.int(1, Math.min(9, a - 1)); return { ast: op('-', n(a), n(b)) }; },
  },
  {
    id: 'mul_small', skill: 'mul', base: 950,
    gen: (r) => { const a = r.int(2, 5); const b = r.int(2, 9); return { ast: op('*', n(a), n(b)) }; },
  },
  {
    id: 'add_2d_nocarry', skill: 'add', base: 1000,
    gen: (r) => { const [a, b] = addWithCarries(r, 11, 89, 'none'); return { ast: op('+', n(a), n(b)) }; },
  },
  {
    id: 'sub_2d_noborrow', skill: 'sub', base: 1050,
    gen: (r) => { const [a, b] = subWithBorrows(r, 11, 98, 'none'); return { ast: op('-', n(a), n(b)) }; },
  },
  {
    id: 'add_2d_carry', skill: 'add', base: 1160,
    gen: (r) => {
      const [a, b] = addWithCarries(r, 14, 89, 'some');
      return { ast: op('+', n(a), n(b)), bump: (carryCount(a, b) - 1) * 70 };
    },
  },
  {
    id: 'sqrt_perfect', skill: 'pow', base: 1180,
    gen: (r) => { const k = r.int(2, 12); return { ast: { k: 'sqrt', v: k * k }, bump: (k - 6) * 14 }; },
  },
  {
    id: 'mul_table', skill: 'mul', base: 1210,
    gen: (r) => {
      const a = r.int(3, 12); const b = r.int(3, 12);
      // 11s and 12s are meaningfully harder to recall than 3x4.
      return { ast: op('*', n(a), n(b)), bump: (Math.max(a, b) >= 11 ? 90 : 0) + (Math.min(a, b) >= 7 ? 60 : 0) };
    },
  },
  {
    id: 'sq_small', skill: 'pow', base: 1260,
    gen: (r) => { const k = r.int(4, 12); return { ast: { k: 'sq', l: n(k) }, bump: (k - 8) * 18 }; },
  },
  {
    id: 'sub_2d_borrow', skill: 'sub', base: 1280,
    gen: (r) => {
      const [a, b] = subWithBorrows(r, 21, 98, 'some');
      return { ast: op('-', n(a), n(b)), bump: (borrowCount(a, b) - 1) * 85 };
    },
  },
  {
    id: 'div_table', skill: 'div', base: 1320,
    gen: (r) => {
      const q = r.int(2, 12); const d = r.int(3, 12);
      return { ast: op('/', n(q * d), n(d)), bump: (d >= 7 ? 70 : 0) };
    },
  },
  {
    id: 'add_3term', skill: 'add', base: 1430,
    gen: (r) => {
      const a = r.int(12, 60); const b = r.int(8, 40);
      if (r.chance(0.5)) {
        const c = r.int(5, Math.max(6, a + b - 5));
        return { ast: op('-', op('+', n(a), n(b)), n(c)) };
      }
      const c = r.int(5, 40);
      return { ast: op('+', op('+', n(a), n(b)), n(c)) };
    },
  },
  {
    id: 'mul_2x1', skill: 'mul', base: 1530,
    gen: (r) => {
      const a = r.int(12, 49); const b = r.int(3, 9);
      return { ast: op('*', n(a), n(b)), bump: (b >= 7 ? 80 : 0) };
    },
  },
  {
    id: 'div_2d', skill: 'div', base: 1640,
    gen: (r) => {
      const q = r.int(4, 20); const d = r.int(4, 15);
      return { ast: op('/', n(q * d), n(d)), bump: (d >= 11 ? 90 : 0) };
    },
  },
  {
    id: 'mul_add', skill: 'mul', base: 1720,
    gen: (r) => {
      const a = r.int(3, 12); const b = r.int(3, 12); const c = r.int(5, 40);
      if (r.chance(0.45) && a * b > c) return { ast: op('-', op('*', n(a), n(b)), n(c)) };
      return { ast: op('+', op('*', n(a), n(b)), n(c)) };
    },
  },
  {
    id: 'paren_mul', skill: 'mul', base: 1870,
    gen: (r) => {
      const a = r.int(4, 18); const b = r.int(3, 15); const c = r.int(2, 8);
      return { ast: op('*', op('+', n(a), n(b)), n(c)) };
    },
  },
  {
    id: 'sq_teen', skill: 'pow', base: 1930,
    gen: (r) => { const k = r.int(13, 25); return { ast: { k: 'sq', l: n(k) }, bump: (k - 18) * 20 }; },
  },
  {
    id: 'mul_2x2', skill: 'mul', base: 2010,
    gen: (r) => {
      const a = r.int(11, 25); const b = r.int(11, 25);
      return { ast: op('*', n(a), n(b)), bump: (a % 10 !== 0 && b % 10 !== 0 ? 60 : -40) };
    },
  },
];

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

export function templateById(id: string): Template | undefined {
  return BY_ID.get(id);
}

export interface GenerateOptions {
  rng: Rng;
  /** Desired item difficulty on the Elo scale. */
  targetRating: number;
  /** Learned per-template ratings, overriding the hand-authored priors. */
  ratings?: Record<string, number>;
  /** Restrict to these skills (used by Practice mode). */
  skills?: readonly Skill[];
  /** Answers already on screen — must not be reused, or voice is ambiguous. */
  exclude?: Set<number>;
  /** Upper bound on the answer, to keep it sayable in one breath. */
  maxAnswer?: number;
  /** How tightly to hug the target rating. Larger = more variety. */
  spread?: number;
}

/** The learned rating for a template, falling back to its prior. */
export function ratingOf(t: Template, ratings?: Record<string, number>): number {
  const learned = ratings?.[t.id];
  return typeof learned === 'number' && Number.isFinite(learned) ? learned : t.base;
}

/**
 * Picks a template near the target difficulty, weighted by a Gaussian kernel
 * so selection stays varied instead of hammering the single closest template.
 */
function pickTemplate(o: GenerateOptions): Template {
  const spread = o.spread ?? 190;
  const pool = o.skills?.length
    ? TEMPLATES.filter((t) => o.skills!.includes(t.skill))
    : TEMPLATES;
  const candidates = pool.length ? pool : TEMPLATES;

  let total = 0;
  const weights = candidates.map((t) => {
    const d = (ratingOf(t, o.ratings) - o.targetRating) / spread;
    // Pure Gaussian, with no flat floor.
    //
    // A floor of 0.004 sounds harmless and is not: across nineteen templates
    // it made roughly seven percent of picks uniform over the entire
    // difficulty range, so a target of 760 still occasionally served
    // two-digit multiplication. On wave one of a gentle ramp that is the
    // single most visible thing in the game, and it undid the ramp entirely.
    const w = Math.exp(-d * d);
    total += w;
    return w;
  });

  // Every template is far from the target — pick the nearest rather than
  // dividing by zero. Only reachable at the extremes of the rating range.
  if (total < 1e-9) {
    let best = candidates[0];
    let bestDist = Infinity;
    for (const t of candidates) {
      const dist = Math.abs(ratingOf(t, o.ratings) - o.targetRating);
      if (dist < bestDist) { bestDist = dist; best = t; }
    }
    return best;
  }

  let roll = o.rng.next() * total;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

/**
 * Produces one problem satisfying every constraint. Retries on violations
 * (excluded answer, out of range, degenerate) and degrades gracefully rather
 * than ever returning null — the spawner must always get an item.
 */
export function generateItem(o: GenerateOptions): Item {
  const maxAnswer = o.maxAnswer ?? 999;
  const exclude = o.exclude;

  let fallback: Item | null = null;

  for (let attempt = 0; attempt < 60; attempt++) {
    const t = pickTemplate(o);
    const draft = t.gen(o.rng);
    const answer = evalNode(draft.ast);

    // Constraint satisfaction: integer, non-negative, in range.
    if (!Number.isInteger(answer) || answer < 0 || answer > maxAnswer) continue;

    const item: Item = {
      text: renderNode(draft.ast),
      answer,
      skill: t.skill,
      templateId: t.id,
      rating: ratingOf(t, o.ratings) + (draft.bump ?? 0),
    };

    if (!fallback) fallback = item;
    if (!exclude || !exclude.has(answer)) return item;
  }

  // Every attempt collided with a live answer. Rather than return a duplicate
  // (which would make one spoken number ambiguous between two blocks), walk a
  // trivial addition upward until we find a free answer.
  for (let v = 2; v <= maxAnswer; v++) {
    if (exclude?.has(v)) continue;
    const a = Math.max(1, Math.floor(v / 2));
    const b = v - a;
    return {
      text: renderNode(op('+', n(a), n(b))),
      answer: v,
      skill: 'add',
      templateId: 'add_1d',
      rating: o.targetRating,
    };
  }

  return fallback ?? { text: '1 + 1', answer: 2, skill: 'add', templateId: 'add_1d', rating: 700 };
}

/**
 * The Daily Challenge sequence. Identical on every device in the world for a
 * given UTC date, generated locally from the date seed alone.
 */
export function generateDailySet(seed: number, count = 40): Item[] {
  const rng = new Rng(seed);
  const items: Item[] = [];
  const used = new Set<number>();

  for (let i = 0; i < count; i++) {
    // A difficulty ramp across the run, identical for everyone.
    const target = 820 + (i / Math.max(1, count - 1)) * 900;
    const item = generateItem({ rng, targetRating: target, exclude: used, maxAnswer: 999 });
    items.push(item);
    used.add(item.answer);
    // Only the most recent answers need to stay distinct; a 40-problem run
    // would otherwise exhaust the small-answer space entirely.
    if (used.size > 12) used.delete(used.values().next().value as number);
  }
  return items;
}
