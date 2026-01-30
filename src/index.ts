
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const cacheHeaders = {
  'Cache-Control': 'public, max-age=3600',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/accessibilityScore') {
      const did = url.searchParams.get('did'); // ✅ remove $ from param name
      if (!did) {
        const score = await env.ACCESSIBILITY_KV.get('pdsAccessibilityScore');
        if (!score) {
          return new Response(JSON.stringify({ error: 'Score not found.' }), {
            status: 404,
            headers: { ...corsHeaders, ...cacheHeaders, 'Content-Type': 'application/json' },
          });        
        }

        let lastUpdated = await env.ACCESSIBILITY_KV.get('lastUpdated');
        if (!lastUpdated) {
          lastUpdated = "Unknown";
        }

        return new Response(JSON.stringify({ score: Number(score), lastUpdated }), {
          status: 200,
          headers: { ...corsHeaders, ...cacheHeaders, 'Content-Type': 'application/json' },
        });
      }

      const score = await env.ACCESSIBILITY_KV.get(did);
      if (!score) {
        return new Response(JSON.stringify({ error: 'Score not found.' }), {
          status: 404,
          headers: { ...corsHeaders, ...cacheHeaders, 'Content-Type': 'application/json' },
        });
      }

      let lastUpdated = await env.ACCESSIBILITY_KV.get('lastUpdated');
      if (!lastUpdated) {
        lastUpdated = "Unknown";
      }

      return new Response(JSON.stringify({ did, score: Number(score), lastUpdated }), {
        status: 200,
        headers: { ...corsHeaders, ...cacheHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/accessibilityScore/all') {

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

      const response = {
        individualScores,
        lastUpdated,
        pdsAccessibilityScore,
      };

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { ...corsHeaders, ...cacheHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    return new Response('Not Found.', { status: 404, headers: { ...corsHeaders, ...cacheHeaders } });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    try {
      const reposResponse = await fetch("https://api.tophhie.cloud/pds/repos");
      if (!reposResponse.ok) throw new Error(`Failed to fetch repos: ${reposResponse.status}`);

      const apiObj = await reposResponse.json();
      const repos = apiObj.repos || []; // ✅ ensure it's an array

      await Promise.all(
        repos.map(async (repo: { did: string, active: boolean }) => {
          if (!repo.active) {
            console.log(`Skipping DID ${repo.did} as it is marked inactive.`);
            return;
          }

          const participates = await validateParticipation(env, repo.did);
          if (!participates) {
            console.log(`Skipping DID ${repo.did} due to user preference.`);
            return;
          }
          const scoreResponse = await fetch(`https://api.tophhie.cloud/pds/accessibilityScore/${repo.did}`);
          if (!scoreResponse.ok) return console.error(`Failed for DID ${repo.did}`);

          const scoreData: { score: number } = await scoreResponse.json();
          await env.ACCESSIBILITY_KV.put(repo.did, scoreData.score.toString());
          console.log(`Updated score for DID ${repo.did}: ${scoreData.score}`);
        })
      );

      const allScores = await Promise.all(repos.map(repo => env.ACCESSIBILITY_KV.get(repo.did)));
      const numericScores = allScores.map(s => Number(s)).filter(n => !isNaN(n));
      const avgScore = numericScores.reduce((sum, n) => sum + n, 0) / numericScores.length;

      await env.ACCESSIBILITY_KV.put("pdsAccessibilityScore", avgScore.toFixed(2));
      await env.ACCESSIBILITY_KV.put("lastUpdated", new Date().toISOString());

      await notifyDiscord(env, `✅ Accessibility scores updated. New PDS Accessibility Score: ${avgScore.toFixed(2)}.`);

      console.log("All scores updated successfully.");
    } catch (err) {
      console.error("Error during scheduled task:", err);
    }
  },
};

export async function notifyDiscord(env: Env, content: string) {
  const url = env.DISCORD_WEBHOOK_URL;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord webhook failed: ${res.status} ${res.statusText} – ${body}`);
  }
}

export async function validateParticipation(env: Env, did: string): Promise<boolean> {
  const recordResponse = await fetch(`https://tophhie.social/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=social.tophhie.profile&rkey=self`)
  if (!recordResponse.ok) {
    try {
      const errorData = await recordResponse.json();
      if (errorData.error === 'RecordNotFound') {
        console.warn(`Profile record for DID ${did} does not exist. Assuming participation...`);
        return true;
      }
    } catch {
      // Ignore JSON parsing errors
    }
    console.warn(`Failed to fetch profile for DID ${did}: ${recordResponse.status}`);
    return true;
  }

  const recordData = await recordResponse.json();
  const profile = recordData.value || {};
  const preference = profile.pdsPreferences?.accessibilityScoring;
  if (preference === undefined) {
    return true;
  }
  return preference === true;
}

interface Env {
  ACCESSIBILITY_KV: KVNamespace;
  API_TOKEN: string;
  DISCORD_WEBHOOK_URL: string;
}