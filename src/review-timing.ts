import { AsyncLocalStorage } from "async_hooks";

/** The review's timed stages, in pipeline order. */
export const REVIEW_STAGES = [
  "context", "discovery", "evidence", "followup", "prior-findings", "contract-evidence", "final-gate",
] as const;
export type ReviewStage = typeof REVIEW_STAGES[number];

export interface StageSpan {
  stage: ReviewStage;
  piece?: number;
  startMs: number;
  endMs: number;
}

/** One model call: wall time from Robin's side and, for subscription seats, the provider's own duration. */
export interface CallSpan {
  stage?: ReviewStage;
  piece?: number;
  startMs: number;
  endMs: number;
  providerMs?: number;
  inFlight: number;
}

const current = new AsyncLocalStorage<{stage: ReviewStage; piece?: number}>();

/** The stage (and piece) the calling code runs under, so a seat can attribute its calls. */
export function currentStage(): {stage: ReviewStage; piece?: number} | undefined {
  return current.getStore();
}

export class ReviewTimings {
  readonly spans: StageSpan[] = [];

  constructor(readonly startedAt = Date.now()) {}

  async time<T>(stage: ReviewStage, run: () => Promise<T>, piece?: number): Promise<T> {
    const startMs = Date.now();
    try {
      return await current.run({stage, piece}, run);
    } finally {
      this.spans.push({stage, piece, startMs, endMs: Date.now()});
    }
  }

  /** Per-piece stage durations, for one log line when a piece finishes. */
  pieceLine(piece: number, total: number): string {
    const spans = this.spans.filter((span) => span.piece === piece);
    const start = Math.min(...spans.map(({startMs}) => startMs));
    const end = Math.max(...spans.map(({endMs}) => endMs));
    const parts = REVIEW_STAGES.flatMap((stage) => {
      const own = spans.filter((span) => span.stage === stage);
      return own.length ? [`${stage} ${seconds(union(own))}`] : [];
    });
    return `Piece ${piece}/${total} done in ${seconds(end - start)} (${parts.join(", ")}), finished at +${seconds(end - this.startedAt)}`;
  }

  /** Wall time each stage was active (overlapping pieces counted once), and each seat's calls. */
  receipt(seats: Array<{model: string; calls: CallSpan[]}>): string {
    const stages = REVIEW_STAGES.flatMap((stage) => {
      const spans = this.spans.filter((span) => span.stage === stage);
      return spans.length ? [`${stage} ${seconds(union(spans))}`] : [];
    });
    const seatParts = seats.filter(({calls}) => calls.length > 0).map(({model, calls}) => {
      const walls = calls.map(({startMs, endMs}) => endMs - startMs);
      const provider = calls.flatMap(({providerMs}) => providerMs === undefined ? [] : [providerMs]);
      return `${model} ${calls.length} calls, p50 ${seconds(percentile(walls, 0.5))}, max ${seconds(Math.max(...walls))}`
        + (provider.length ? `, provider p50 ${seconds(percentile(provider, 0.5))}` : "")
        + `, peak ${Math.max(...calls.map(({inFlight}) => inFlight))} in flight`;
    });
    const total = Math.max(this.startedAt, ...this.spans.map(({endMs}) => endMs)) - this.startedAt;
    return [`Robin timing: ${seconds(total)} · ${stages.join(" · ")}`, ...seatParts.map((part) => `Robin seat: ${part}`)].join("\n");
  }
}

/** Length of the union of the intervals: wall time during which at least one ran. */
export function union(spans: Array<{startMs: number; endMs: number}>): number {
  const sorted = [...spans].sort((left, right) => left.startMs - right.startMs);
  let covered = 0;
  let end = -Infinity;
  for (const {startMs, endMs} of sorted) {
    if (endMs <= end) continue;
    covered += endMs - Math.max(startMs, end);
    end = endMs;
  }
  return covered;
}

export function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
