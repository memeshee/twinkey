import { NextResponse } from "next/server";

/**
 * GET /api/ping — answered from process memory, nothing else.
 *
 * This exists because the platform's health probe budget is 5 seconds and kills + restarts the
 * instance when it is missed. `/api/health` is the *product's* honest status report: it makes three
 * upstream calls, and on a cold instance those can take longer than any probe is willing to wait.
 * Pointing a platform probe at it turns a slow wake-up into a restart loop, so the probe gets a path
 * that cannot be slow, and `/api/health` stays the thing a human reads.
 *
 * No upstream call, no chain read, no filesystem: if the process can answer HTTP at all, this says so.
 */
export const dynamic = "force-dynamic";

const started = Date.now();

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      service: "twinkey",
      uptime_s: Math.round((Date.now() - started) / 1000),
      // Same build identity the product reports, so "which commit is live" has one answer.
      git_sha: process.env.GIT_SHA ?? null,
      git_sha_short: (process.env.GIT_SHA ?? "").slice(0, 7) || null,
      region: process.env.FLY_REGION ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
