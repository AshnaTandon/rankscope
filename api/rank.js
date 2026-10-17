
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Use POST"
    });
  }

const apiKey = process.env.SERP_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "SERP_API_KEY is not configured in Vercel."
    });
  }

  try {
    const { domain, keywords, cities, depth = 10 } = req.body || {};

    if (
      typeof domain !== "string" ||
      !Array.isArray(keywords) ||
      !Array.isArray(cities) ||
      keywords.length < 1 ||
      keywords.length > 50 ||
      cities.length < 1 ||
      cities.length > 10 ||
      ![10, 100].includes(Number(depth))
    ) {
      return res.status(400).json({
        error: "Invalid domain, keywords, cities, or depth."
      });
    }

    const cleanDomain = domain
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .split("/")[0]
      .toLowerCase();

    if (
      !/^(?=.{1,253}$)[a-z0-9]+([-.][a-z0-9]+)*\.[a-z]{2,}$/i
        .test(cleanDomain)
    ) {
      return res.status(400).json({
        error: "Enter a valid domain."
      });
    }

    const uniqueKeywords = [
      ...new Set(
        keywords
          .filter(k => typeof k === "string")
          .map(k => k.trim())
          .filter(Boolean)
      )
    ];

    if (!uniqueKeywords.length || uniqueKeywords.length > 50) {
      return res.status(400).json({
        error: "Enter 1–50 unique keywords."
      });
    }

    const jobs = uniqueKeywords.flatMap(keyword =>
      cities.map(city => ({ keyword, city }))
    );

    // Conservative credit estimate for one check per
    // keyword-location pair. Confirm the current provider pricing.
    const estimatedCredits =
      jobs.length * (Number(depth) === 100 ? 7 : 1);

    const accountResponse = await fetch(
      "https://api.serpkite.com/v1/account",
      {
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        cache: "no-store"
      }
    );

    if (!accountResponse.ok) {
      return res.status(502).json({
        error: "Could not verify API credits."
      });
    }

    const account = await accountResponse.json();
    const balance = Number(account.balance);

    if (
      !Number.isFinite(balance) ||
      balance < estimatedCredits
    ) {
      return res.status(402).json({
        error: "Insufficient or unverifiable API credits.",
        estimatedCredits,
        availableCredits: Number.isFinite(balance) ? balance : null
      });
    }

    const results = [];

    // Sequential requests reduce concurrency and quota surprises.
    // Large batches may need asynchronous jobs.
    for (const job of jobs) {
      const city = typeof job.city === "string"
        ? { city: job.city, country: "ca" }
        : job.city;

      const response = await fetch(
        "https://api.serpkite.com/v1/rank",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            q: job.keyword,
            domain: cleanDomain,
            country: city.country,
            location: city.city,
            language: "en",
            engine: "google",
            num: Number(depth)
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(25000)
        }
      );

      if (!response.ok) {
        results.push({
          keyword: job.keyword,
          city: city.city,
          position: null,
          url: null,
          status: `Provider error ${response.status}`
        });
        continue;
      }

      const data = await response.json();
      const position = Number(data.position) || null;
      const match = Array.isArray(data.matches)
        ? data.matches.find(item => item.link)
        : null;

      results.push({
        keyword: job.keyword,
        city: city.city,
        position,
        page: position ? Math.ceil(position / 10) : null,
        positionOnPage: position
          ? ((position - 1) % 10) + 1
          : null,
        url: match?.link || null,
        status: position
          ? "Found"
          : `Not found in Top ${depth}`,
        checkedAt: new Date().toISOString(),
        creditsUsed: data.meta?.credits_used ?? null
      });
    }

    return res.status(200).json({
      mode: "live",
      domain: cleanDomain,
      estimatedCredits,
      results
    });
  } catch (error) {
    console.error("Ranking request failed:", error);

    return res.status(502).json({
      error: "Ranking request failed. Check provider settings and logs."
    });
  }
}
