/**
 * Itinerary generation benchmark.
 *
 * Measures how long a full, live-data trip generation takes and how many
 * external provider calls it makes. Each run happens in a fresh process so the
 * in-memory provider cache starts cold, the way a first request would.
 *
 *   pnpm run benchmark            # 5 cold runs (default)
 *   pnpm run benchmark -- 10      # 10 cold runs
 *
 * Requires GEOAPIFY_API_KEY and IGNAV_API_KEY in the root .env to hit the real
 * providers. Without keys the numbers only reflect the fallback path.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateEnrichedItinerary } from "../../artifacts/api-server/src/lib/live-data";
import type { TripData } from "../../artifacts/api-server/src/lib/itinerary-generator";

const SAMPLE_TRIP: TripData = {
  id: "benchmark",
  destination: "Italy and Switzerland",
  starting_location: "New York, NY",
  start_date: "2027-06-10",
  end_date: "2027-06-18",
  traveler_count: 2,
  budget: 5000,
  budget_preference: "Balance",
  traveler_profile: { interests: ["Nature", "Photography", "Food"], travel_style: "Balanced", preferences: [] },
};

interface RunResult {
  ms: number;
  calls: number;
  byHost: Record<string, number>;
}

async function runOnce(): Promise<RunResult> {
  const byHost: Record<string, number> = {};
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    byHost[url.hostname] = (byHost[url.hostname] ?? 0) + 1;
    calls++;
    return realFetch(input, init);
  };
  const start = performance.now();
  await generateEnrichedItinerary(SAMPLE_TRIP);
  const ms = performance.now() - start;
  globalThis.fetch = realFetch;
  return { ms, calls, byHost };
}

function runInFreshProcess(): Promise<RunResult> {
  const script = fileURLToPath(import.meta.url);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, script, "--once"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      const line = out.trim().split("\n").pop() ?? "";
      if (code !== 0 || !line.startsWith("{")) {
        reject(new Error(`benchmark run failed (exit ${code})`));
        return;
      }
      resolve(JSON.parse(line) as RunResult);
    });
  });
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

if (process.argv.includes("--once")) {
  const result = await runOnce();
  process.stdout.write(`\n${JSON.stringify(result)}\n`);
  process.exit(0);
} else {
  const runs = Number(process.argv[2] ?? 5);
  if (!process.env.GEOAPIFY_API_KEY || !process.env.IGNAV_API_KEY) {
    console.warn("Warning: provider API keys are missing, so this measures the fallback path only.\n");
  }
  console.log(`Trip: ${SAMPLE_TRIP.destination}, ${SAMPLE_TRIP.start_date} to ${SAMPLE_TRIP.end_date}`);
  console.log(`Cold runs: ${runs}\n`);
  const results: RunResult[] = [];
  for (let i = 1; i <= runs; i++) {
    const result = await runInFreshProcess();
    results.push(result);
    console.log(`Run ${i}: ${(result.ms / 1000).toFixed(2)}s, ${result.calls} provider calls`);
  }
  const times = results.map((r) => r.ms / 1000);
  const calls = results.map((r) => r.calls);
  console.log(`\nMedian generation time: ${median(times).toFixed(2)}s (min ${Math.min(...times).toFixed(2)}s, max ${Math.max(...times).toFixed(2)}s)`);
  console.log(`Median provider calls: ${median(calls)}`);
  console.log("Calls by provider (last run):", results[results.length - 1].byHost);
}
