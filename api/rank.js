export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST required" });
  }

  const apiKey = process.env.SERP_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "SERP_API_KEY is missing in Vercel Environment Variables."
    });
  }

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);

    const { domain, keywords, cities, depth = 10 } = body || {};

    if (
      typeof domain !== "string" ||
      !Array.isArray(keywords) ||
      !Array.isArray(cities) ||
      keywords.length !== 1 ||
      cities.length !== 1 ||
      ![10, 100].includes(Number(depth))
    ) {
      return res.status(400).json({
        error: "One keyword and one city are required per request."
      });
    }

    const hostInput = domain
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .split("/")[0];

    if (!/^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(hostInput)) {
      return res.status(400).json({ error: "Invalid domain." });
    }

    const keyword = String(keywords[0]).trim();
    const city = cities[0];

    if (
      !keyword ||
      keyword.length > 200 ||
      !city ||
      typeof city.city !== "string" ||
      typeof city.country !== "string"
    ) {
      return res.status(400).json({ error: "Invalid keyword or city." });
    }

    const payload = {
      q: keyword,
      gl: city.country.toLowerCase(),
      hl: "en",
      num: Number(depth)
    };
    if (city.countryName) {
      payload.location = `${city.city}, ${city.countryName}`;
    }

    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.error) {
      console.error("Serper error:", response.status, data);
      const msg =
        data.message ||
        (typeof data.error === "string" ? data.error : data.error?.message) ||
        "Serper search request failed.";
      return res
        .status(response.status >= 400 && response.status < 600 ? response.status : 502)
        .json({ error: msg });
    }

    const organic = Array.isArray(data.organic) ? data.organic : [];
    const target = hostInput.toLowerCase();

    const match = organic.find(item => {
      try {
        const h = new URL(item.link).hostname.toLowerCase().replace(/^www\./, "");
        return h === target || h.endsWith("." + target);
      } catch {
        return false;
      }
    });

    const position = match ? Number(match.position) : null;

    const result = {
      mode: "live",
      keyword,
      domain: target,
      city: city.city,
      country: city.country,
      position,
      page: position ? Math.ceil(position / 10) : null,
      positionOnPage: position ? ((position - 1) % 10) + 1 : null,
      url: match?.link || null,
      status: match ? "Found" : `Not found in Top ${depth} (checked ${organic.length} results)`,
checked: organic.length,
topResults: organic.slice(0, 5).map(o => o.link),
      creditsUsed: data.credits ?? 1,
      checkedAt: new Date().toISOString()
    };

    // Return in the shape the frontend expects
    return res.status(200).json({ results: [result] });

  } catch (error) {
    console.error("Rank API error:", error);
    return res.status(502).json({
      error: "Could not fetch Google results. Check Vercel Function Logs."
    });
  }
}
