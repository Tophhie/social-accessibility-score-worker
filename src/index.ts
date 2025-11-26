
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    try {
      // 1. Fetch all repos from the PDS
      const reposResponse = await fetch("https://api.tophhie.cloud/pds/repos", {
      });

      if (!reposResponse.ok) {
        throw new Error(`Failed to fetch repos: ${reposResponse.status}`);
      }

      const apiObj = await reposResponse.json();

      // 2. For each repo, fetch accessibility score and store in KV
      await Promise.all(
        apiObj.repos.map(async (repo) => {
          const did = repo.did;
          const scoreResponse = await fetch(
            `https://api.tophhie.cloud/pds/accessibilityScore/${did}`
          );

          if (!scoreResponse.ok) {
            console.error(`Failed to fetch score for DID ${did}: ${scoreResponse.status}`);
            return;
          }

          const scoreData: { score: number } = await scoreResponse.json();

          // 3. Store score in KV with DID as key
          try {
            await env.ACCESSIBILITY_KV.put(did, scoreData.score.toString())
          } catch {
            console.log(`Could not store accessibility score for ${did}.`)
          }
          console.log(`Stored score for ${did}: ${scoreData.score}`);
        })
      );

      console.log("All scores updated successfully.");
    } catch (err) {
      console.error("Error during scheduled task:", err);
    }
  },
};

// Types for environment bindings
interface Env {
  ACCESSIBILITY_KV: KVNamespace;
  API_TOKEN: string;
}