// ---- CORS & Cache headers ----
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const cacheHeaders = { "Cache-Control": "public, max-age=3600" };

// ---- Concurrency control (network only) ----
const MAX_CONCURRENCY = 6; // Cloudflare allows 6 simultaneous outgoing connections per invocation

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((res) => this.queue.push(res));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

function makeLimitedFetch(limit: Semaphore) {
  return async function limitedFetch(input: RequestInfo, init?: RequestInit) {
    return limit.run(() => fetch(input, init));
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/accessibilityScore") {
      const did = url.searchParams.get("did");
      const headers = { ...corsHeaders, ...cacheHeaders, "Content-Type": "application/json" };

      if (!did) {
        const score = await env.ACCESSIBILITY_KV.get("pdsAccessibilityScore");
        if (!score) {
          return new Response(JSON.stringify({ error: "Score not found." }), {
            status: 404,
            headers,
          });
        }

        let lastUpdated = await env.ACCESSIBILITY_KV.get("lastUpdated");
        if (!lastUpdated) lastUpdated = "Unknown";

        return new Response(JSON.stringify({ score: Number(score), lastUpdated }), {
          status: 200,
          headers,
        });
      }

      const score = await env.ACCESSIBILITY_KV.get(did);
      if (!score) {
        return new Response(JSON.stringify({ error: "Score not found." }), {
          status: 404,
          headers,
        });
      }

      let lastUpdated = await env.ACCESSIBILITY_KV.get("lastUpdated");
      if (!lastUpdated) lastUpdated = "Unknown";

      return new Response(JSON.stringify({ did, score: Number(score), lastUpdated }), {
        status: 200,
        headers,
      });
    }

    if (url.pathname === "/accessibilityScore/all") {
      const headers = { ...corsHeaders, ...cacheHeaders, "Content-Type": "application/json" };

      const listResult = await env.ACCESSIBILITY_KV.list();
      const individualScores: { did: string; score: number }[] = [];
      let lastUpdated: string | null = null;
      let pdsAccessibilityScore: number | null = null;

      await Promise.all(
        listResult.keys.map(async (key) => {
          const value = await env.ACCESSIBILITY_KV.get(key.name);
          if (!value) return;

          if (key.name === "lastUpdated") {
            lastUpdated = value;
          } else if (key.name === "pdsAccessibilityScore") {
            pdsAccessibilityScore = Number(value);
          } else {
            individualScores.push({ did: key.name, score: Number(value) });
          }
        })
      );

      const response = { individualScores, lastUpdated, pdsAccessibilityScore };
      return new Response(JSON.stringify(response), { status: 200, headers });
    }

    return new Response("Not Found.", { status: 404, headers: { ...corsHeaders, ...cacheHeaders } });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    try {
      // Gate all external fetches behind a 6-connection semaphore
      const sem = new Semaphore(MAX_CONCURRENCY);
      const limitedFetch = makeLimitedFetch(sem);

      // 1) Repos list (external)
      const reposResponse = await limitedFetch("https://api.tophhie.cloud/pds/repos");
      if (!reposResponse.ok) throw new Error(`Failed to fetch repos: ${reposResponse.status}`);

      const apiObj = await reposResponse.json();
      const repos = (apiObj.repos || []) as Array<{ did: string; active: boolean }>;

      // 2) Process all repos with controlled concurrency
      await Promise.all(
        repos.map(async (repo) => {
          if (!repo.active) {
            console.log(`Skipping DID ${repo.did} as it is marked inactive.`);
            return;
          }

          // External call (limited)
          const participates = await validateParticipationWithLimit(env, repo.did, limitedFetch);
          if (!participates) {
            console.log(`Skipping DID ${repo.did} due to user preference.`);
            return;
          }

          // External call (limited)
          const scoreResponse = await limitedFetch(
            `https://api.tophhie.cloud/pds/accessibilityScore/${repo.did}`
          );
          if (!scoreResponse.ok) {
            console.error(`Failed for DID ${repo.did}`);
            scoreResponse.body?.cancel();
            return;
          }

          const scoreData: { score: number } = await scoreResponse.json();
          await env.ACCESSIBILITY_KV.put(repo.did, scoreData.score.toString()); // KV write (not a network subrequest)
          console.log(`Updated score for DID ${repo.did}: ${scoreData.score}`);
        })
      );

      // 3) Compute average from KV reads (or from in-memory if you prefer to store during loop)
      const allScores = await Promise.all(repos.map((repo) => env.ACCESSIBILITY_KV.get(repo.did)));
      const numericScores = allScores.map((s) => Number(s)).filter((n) => !isNaN(n));
      const avgScore =
        numericScores.length === 0
          ? NaN
          : numericScores.reduce((sum, n) => sum + n, 0) / numericScores.length;

      if (!Number.isNaN(avgScore)) {
        await env.ACCESSIBILITY_KV.put("pdsAccessibilityScore", avgScore.toFixed(2));
      }
      await env.ACCESSIBILITY_KV.put("lastUpdated", new Date().toISOString());

      // 4) Discord webhook (external) — fire and forget
      ctx.waitUntil(
        notifyDiscord(
          env,
          Number.isNaN(avgScore)
            ? `✅ Accessibility scores updated for ${repos.length} repos.`
            : `✅ Accessibility scores updated. New PDS Accessibility Score: ${avgScore.toFixed(2)}.`
        )
      );

      console.log("All scores updated successfully.");
    } catch (err) {
      console.error("Error during scheduled task:", err);
    }
  },
};

async function validateParticipationWithLimit(
  env: Env,
  did: string,
  limitedFetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>
): Promise<boolean> {
  const recordResponse = await limitedFetch(
    `https://tophhie.social/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=social.tophhie.profile&rkey=self`
  );

  if (!recordResponse.ok) {
    try {
      const errorData = await recordResponse.json();
      if (errorData?.error === "RecordNotFound") {
        console.warn(`Profile record for DID ${did} does not exist. Assuming participation...`);
        return true;
      }
    } catch {
      // Ignore JSON parsing errors
    }
    console.warn(`Failed to fetch profile for DID ${did}: ${recordResponse.status}`);
    return true; // lenient default
  }

  const recordData = await recordResponse.json();
  const profile = recordData.value || {};
  const preference = profile.pdsPreferences?.accessibilityScoring;
  if (preference === undefined) return true;
  return preference === true;
}

export async function notifyDiscord(env: Env, content: string) {
  const url = env.DISCORD_WEBHOOK_URL;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord webhook failed: ${res.status} ${res.statusText} – ${body}`);
  }
}

interface Env {
  ACCESSIBILITY_KV: KVNamespace;
  API_TOKEN: string;
  DISCORD_WEBHOOK_URL: string;
}