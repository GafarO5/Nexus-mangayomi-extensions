const mangayomiSources = [{
    "name": "AnimePahe",
    "id": 771294483,
    "baseUrl": "https://animepahe.pw",
    "lang": "en",
    "typeSource": "single",
    "iconUrl": "https://raw.githubusercontent.com/GafarO5/Nexus-mangayomi-extensions/main/anime/src/en/animepahe/icon.png",
    "dateFormat": "",
    "dateFormatLocale": "",
    "isNsfw": false,
    "hasCloudflare": true,
    "sourceCodeUrl": "https://raw.githubusercontent.com/GafarO5/Nexus-mangayomi-extensions/main/anime/src/en/animepahe.js",
    "apiUrl": "",
    "version": "0.0.1",
    "isManga": false,
    "itemType": 1,
    "isFullData": false,
    "appMinVerReq": "0.5.0",
    "additionalParams": "",
    "sourceCodeLanguage": 1,
    "notes": ""
}];

class DefaultExtension extends MProvider {

    getHeaders(url) {
        // Do NOT override User-Agent -- Cloudflare cf_clearance must match
        // the WebView's own UA or the cookie is rejected.
        return {
            "Referer": this.source.baseUrl + "/",
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/javascript, */*; q=0.01"
        };
    }

    // Guard against Cloudflare HTML being fed to JSON.parse, which throws an
    // ugly QuickJS stack trace instead of something actionable.
    safeJson(body, ctx) {
        const t = (body || "").trim();
        if (t === "") {
            throw new Error("Empty response from " + ctx + " (session may be invalid)");
        }
        if (t.startsWith("<")) {
            throw new Error(
                "Cloudflare challenge on " + ctx +
                ". Open WebView, let the site load fully, back out, then Refresh."
            );
        }
        try {
            return JSON.parse(t);
        } catch (e) {
            throw new Error("Bad JSON from " + ctx + ": " + t.slice(0, 120));
        }
    }

    async req(url) {
        const res = await new Client().get(url, this.getHeaders(url));
        return this.safeJson(res.body, url);
    }

    // AnimePahe has no popular endpoint; the Kotlin source falls back to
    // airing, so we do the same.
    async getPopular(page) {
        return await this.getLatestUpdates(page);
    }

    async getLatestUpdates(page) {
        const data = await this.req(
            `${this.source.baseUrl}/api?m=airing&page=${page}`
        );
        const list = (data.data || []).map(a => ({
            name: a.anime_title || a.title,
            imageUrl: a.snapshot,
            // Store the STABLE anime_id, never the ephemeral session.
            link: `/anime/?anime_id=${a.anime_id || a.id}`
        }));
        return {
            list: list,
            hasNextPage: (data.current_page || 1) < (data.last_page || 1)
        };
    }

    async search(query, page, filters) {
        const data = await this.req(
            `${this.source.baseUrl}/api?m=search&l=8&q=${encodeURIComponent(query)}`
        );
        const list = (data.data || []).map(a => ({
            name: a.title,
            imageUrl: a.poster,
            link: `/anime/?anime_id=${a.id}`
        }));
        return { list: list, hasNextPage: false };
    }

    getId(link) {
        return link.split("anime_id=")[1].split("&")[0].split('"')[0];
    }

    // Resolve the current session by following /a/<id>, which redirects to
    // /anime/<session>. The session is read out of the final URL -- no scrape.
    async fetchSession(animeId) {
        const res = await new Client().get(
            `${this.source.baseUrl}/a/${animeId}`,
            this.getHeaders("")
        );

        // Prefer the post-redirect URL if the client exposes it.
        const finalUrl = res.request && res.request.url ? res.request.url : "";
        let m = finalUrl.match(/\/anime\/([0-9a-f-]{8,})/i);
        if (m) return m[1];

        // Fallback: pull the session out of the returned document.
        const body = res.body || "";
        m = body.match(/\/(?:anime|play)\/([0-9a-f]{8}-[0-9a-f-]+)/i);
        if (m) return m[1];

        throw new Error("Could not resolve session for anime_id " + animeId);
    }

    async getDetail(url) {
        const animeId = this.getId(url);
        const session = await this.fetchSession(animeId);

        // Details come from the rendered anime page.
        const res = await new Client().get(
            `${this.source.baseUrl}/anime/${session}`,
            this.getHeaders("")
        );
        const doc = new Document(res.body);

        const description = doc.selectFirst("div.anime-synopsis")?.text?.trim() ?? "";
        const imageUrl = doc.selectFirst("div.anime-poster img")?.attr("data-src")
            ?? doc.selectFirst("div.anime-poster img")?.attr("src") ?? "";
        const name = doc.selectFirst("div.title-wrapper h1 span")?.text?.trim()
            ?? doc.selectFirst("h1")?.text?.trim() ?? "";

        const genre = doc.select("div.anime-genre ul li a")
            .map(e => (e.attr("title") || e.text || "").trim())
            .filter(g => g.length > 0);

        // Status is rendered in the info sidebar as "Status: Currently Airing".
        const infoText = doc.select("div.anime-info p").map(e => e.text).join(" ");
        let status = 5; // unknown
        if (infoText.includes("Currently Airing")) status = 0;      // ongoing
        else if (infoText.includes("Finished Airing")) status = 1;  // completed

        const episodes = await this.getEpisodes(session);

        return {
            name: name,
            imageUrl: imageUrl,
            description: description,
            genre: genre,
            status: status,
            chapters: episodes
        };
    }

    // Episode list is paginated; walk every page.
    async getEpisodes(session) {
        let all = [];
        let page = 1;
        let lastPage = 1;

        do {
            const data = await this.req(
                `${this.source.baseUrl}/api?m=release&id=${session}` +
                `&sort=episode_desc&page=${page}`
            );
            lastPage = data.last_page || 1;

            for (const ep of (data.data || [])) {
                all.push({
                    name: "Episode " + ep.episode,
                    url: `/play/${session}/${ep.session}`,
                    dateUpload: this.toDate(ep.created_at),
                    epNum: ep.episode
                });
            }
            page++;
        } while (page <= lastPage);

        // Newest first.
        all.sort((a, b) => b.epNum - a.epNum);
        return all.map(e => ({
            name: e.name,
            url: e.url,
            dateUpload: e.dateUpload
        }));
    }

    // "2026-07-12 13:09:22" -> epoch millis as a string
    toDate(s) {
        if (!s) return "";
        const m = s.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
        if (!m) return "";
        return String(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    }

    async getVideoList(url) {
        // Kwik playback is not implemented yet -- see notes.
        throw new Error("Playback not implemented yet (Kwik extractor pending).");
    }

    getFilterList() { return []; }
    getSourcePreferences() { return []; }
}
