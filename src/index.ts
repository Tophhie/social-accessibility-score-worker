
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
            headers: { 'Content-Type': 'application/json' },
          });        
        }

        let lastUpdated = await env.ACCESSIBILITY_KV.get('lastUpdated');
        if (!lastUpdated) {
          lastUpdated = "Unknown";
        }

        return new Response(JSON.stringify({ score: Number(score), lastUpdated }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const score = await env.ACCESSIBILITY_KV.get(did);
      if (!score) {
        return new Response(JSON.stringify({ error: 'Score not found.' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      let lastUpdated = await env.ACCESSIBILITY_KV.get('lastUpdated');
      if (!lastUpdated) {
        lastUpdated = "Unknown";
      }

      return new Response(JSON.stringify({ did, score: Number(score), lastUpdated }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found.', { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    try {
      const reposResponse = await fetch("https://api.tophhie.cloud/pds/repos");
      if (!reposResponse.ok) throw new Error(`Failed to fetch repos: ${reposResponse.status}`);

      const apiObj = await reposResponse.json();
      const repos = apiObj.repos || []; // ✅ ensure it's an array

      await Promise.all(
        repos.map(async (repo: { did: string }) => {
          const scoreResponse = await fetch(`https://api.tophhie.cloud/pds/accessibilityScore/${repo.did}`);
          if (!scoreResponse.ok) return console.error(`Failed for DID ${repo.did}`);

          const scoreData: { score: number } = await scoreResponse.json();
          await env.ACCESSIBILITY_KV.put(repo.did, scoreData.score.toString());
        })
      );

      const allScores = await Promise.all(repos.map(repo => env.ACCESSIBILITY_KV.get(repo.did)));
      const numericScores = allScores.map(s => Number(s)).filter(n => !isNaN(n));
      const avgScore = numericScores.reduce((sum, n) => sum + n, 0) / numericScores.length;

      await env.ACCESSIBILITY_KV.put("pdsAccessibilityScore", avgScore.toFixed(2));
      await env.ACCESSIBILITY_KV.put("lastUpdated", new Date().toISOString());

      console.log("All scores updated successfully.");
    } catch (err) {
      console.error("Error during scheduled task:", err);
    }
  },
};

interface Env {
  ACCESSIBILITY_KV: KVNamespace;
  API_TOKEN: string;
}