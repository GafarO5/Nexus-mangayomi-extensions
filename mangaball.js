const mangayomiSources = [
    {
        "name": "Mangaball",
        "lang": "en",
        "baseUrl": "https://mangaball.net",
        "apiUrl": "https://mangaball.net",
        "iconUrl": "https://mangaball.net/favicon.ico",
        "typeSource": "single",
        "itemType": 0,
        "isNsfw": true,
        "version": "0.0.1",
        "pkgPath": "manga/src/en/mangaball.js"
    }
];

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client();
        this.csrf = null;
    }

    get siteLang() {
        return ["en"];
    }

    baseHeaders() {
        return {
            "Referer": `${this.source.baseUrl}/`,
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        };
    }

    // ---- CSRF token handling -------------------------------------------
    // POSTs to /api/v1/* require X-CSRF-TOKEN, read from a <meta> tag on any
    // page. We fetch the homepage once, cache the token, and refresh on 403.
    async updateCsrf() {
        const res = await this.client.get(`${this.source.baseUrl}/`, this.baseHeaders());
        const doc = new Document(res.body);
        const token = doc.selectFirst("meta[name=csrf-token]")?.attr("content");
        if (token && token.trim()) this.csrf = token.trim();
        return this.csrf;
    }

    async getCsrf() {
        if (!this.csrf) await this.updateCsrf();
        if (!this.csrf) throw new Error("CSRF token not found");
        return this.csrf;
    }

    // POST with CSRF + form-urlencoded body, retrying once on a 403.
    async apiPost(path, body) {
        const doPost = async () => {
            const headers = {
                ...this.baseHeaders(),
                "Origin": this.source.baseUrl,
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                "X-CSRF-TOKEN": await this.getCsrf()
            };
            return await this.client.post(`${this.source.baseUrl}${path}`, headers, body);
        };

        let res = await doPost();
        if (res.statusCode === 403) {
            await this.updateCsrf();
            res = await doPost();
        }
        return res;
    }

    // Parse JSON defensively. If the body is a Cloudflare challenge page or
    // any non-JSON HTML, throw a clear error instead of crashing inside .map().
    safeJson(body) {
        try {
            return JSON.parse(body);
        } catch (e) {
            const snippet = `${body}`.slice(0, 200).toLowerCase();
            if (snippet.includes("just a moment") ||
                snippet.includes("cloudflare") ||
                snippet.includes("<!doctype") ||
                snippet.includes("<html")) {
                throw new Error("Cloudflare block: open Webview, let the site load, then Refresh.");
            }
            throw new Error("Unexpected non-JSON response from Mangaball.");
        }
    }

    // Manga card url is the slug: second path segment of the manga url.
    slugFromUrl(url) {
        // url like "/title-detail/<slug>/" or full https URL
        const clean = `${url}`.replace(/^https?:\/\/[^/]+/, "");
        const segs = clean.split("/").filter(Boolean);
        // segs[0] == "title-detail", segs[1] == slug
        return segs.length >= 2 ? segs[1] : segs[0] || "";
    }

    // ---- Browse (advanced search with sort) ----------------------------
    // sort values: views_desc (popular), updated_chapters_desc (latest/default)
    async advancedSearch(query, page, sort) {
        const body = {
            "search_input": (query || "").trim(),
            "filters[sort]": sort,
            "filters[page]": `${page}`,
            "filters[tag_included_mode]": "and",
            "filters[tag_excluded_mode]": "or",
            "filters[contentRating]": "any",
            "filters[demographic]": "any",
            "filters[person]": "any",
            "filters[publicationYear]": "",
            "filters[publicationStatus]": "any"
        };
        // translatedLanguage[] — one entry per site language.
        for (const l of this.siteLang) {
            body["filters[translatedLanguage][]"] = l;
        }

        const res = await this.apiPost("/api/v1/title/search-advanced/", body);
        const data = this.safeJson(res.body);
        const list = (data.data || []).map(m => ({
            name: m.name,
            imageUrl: m.cover,
            link: this.slugFromUrl(m.url)
        }));
        const pag = data.pagination || {};
        const hasNextPage = (pag.current_page ?? 1) < (pag.last_page ?? 1);
        return { list, hasNextPage };
    }

    async getPopular(page) {
        return await this.advancedSearch("", page, "views_desc");
    }

    async getLatestUpdates(page) {
        return await this.advancedSearch("", page, "updated_chapters_desc");
    }

    async search(query, page, filterList) {
        // Quick text search uses the smart-search endpoint on page 1; deeper
        // pages fall back to advanced search so pagination keeps working.
        if (query && query.trim() && parseInt(page) === 1) {
            const res = await this.apiPost("/api/v1/smart-search/search/", {
                "search_input": query.trim()
            });
            const data = this.safeJson(res.body);
            const mangas = ((data.data && data.data.manga) || []).map(m => ({
                name: m.title,
                imageUrl: m.img,
                link: this.slugFromUrl(m.url)
            }));
            return { list: mangas, hasNextPage: true };
        }
        // For blank query or later pages, use advanced search.
        const p = (query && query.trim()) ? (parseInt(page) - 1) : parseInt(page);
        return await this.advancedSearch(query, p || 1, "updated_chapters_desc");
    }

    // ---- Details -------------------------------------------------------
    async getDetail(url) {
        const slug = this.slugFromUrl(url);
        const res = await this.client.get(
            `${this.source.baseUrl}/title-detail/${slug}/`,
            this.baseHeaders()
        );
        const doc = new Document(res.body);
        // Refresh CSRF while we have a page in hand.
        const metaToken = doc.selectFirst("meta[name=csrf-token]")?.attr("content");
        if (metaToken && metaToken.trim()) this.csrf = metaToken.trim();

        const manga = {};
        manga.imageUrl = doc.selectFirst("img.featured-cover")?.attr("src") || "";

        // Genre = origin (from flag) + tag names.
        const genres = [];
        const flag = doc.selectFirst("#featuredComicsCarousel img[src*=/flags/]")?.attr("src") || "";
        if (flag.includes("jp")) genres.push("Manga");
        else if (flag.includes("kr")) genres.push("Manhwa");
        else if (flag.includes("cn")) genres.push("Manhua");
        for (const t of doc.select("#comicDetail span[data-tag-id]")) {
            const g = t.ownText?.trim() || t.text?.trim();
            if (g) genres.push(g);
        }
        manga.genre = genres;

        const authors = [];
        for (const a of doc.select("#comicDetail span[data-person-id]")) {
            const n = (a.text || "").trim();
            if (n) authors.push(n);
        }
        if (authors.length) manga.author = authors.join(", ");

        // Description = synopsis + published + alt names.
        let desc = "";
        const syn = doc.selectFirst("#descriptionContent p")?.text;
        if (syn) desc += syn.trim();
        const published = doc.selectFirst("#comicDetail span.badge:contains(Published)")?.text;
        if (published) desc += `\n\n${published.trim()}`;
        const altContainer = doc.selectFirst("div.alternate-name-container")?.text;
        if (altContainer) {
            const titles = altContainer.split("/").map(t => t.trim()).filter(Boolean);
            if (titles.length) {
                desc += "\n\nAlternative Names:\n" + titles.map(t => `- ${t}`).join("\n");
            }
        }
        manga.description = desc.trim();

        const statusText = doc.selectFirst("span.badge-status")?.text?.trim();
        manga.status = this.mapStatus(statusText);

        manga.chapters = await this.fetchChapters(slug);
        return manga;
    }

    mapStatus(text) {
        switch (text) {
            case "Ongoing": return 0;
            case "Completed": return 1;
            case "Hiatus": return 2;
            case "Cancelled": return 3;
            default: return 5;
        }
    }

    // ---- Chapters ------------------------------------------------------
    async fetchChapters(slug) {
        // title_id is the trailing numeric id of the slug (e.g. "naruto-123" -> "123").
        const titleId = slug.substring(slug.lastIndexOf("-") + 1);
        const res = await this.apiPost("/api/v1/chapter/chapter-listing-by-title-id/", {
            "title_id": titleId
        });
        const data = this.safeJson(res.body);
        const containers = data.ALL_CHAPTERS || [];

        const chapters = [];
        for (const container of containers) {
            const number = container.number_float;
            const numStr = `${number}`.replace(/\.0$/, "");
            for (const tr of (container.translations || [])) {
                if (!this.siteLang.includes(tr.language)) continue;

                let name = "";
                const volStr = `${tr.volume}`.replace(/\.0$/, "");
                if (tr.volume > 0) name += `Vol. ${volStr} `;
                if ((tr.name || "").includes(numStr)) {
                    name += (tr.name || "").trim();
                } else {
                    name += `Ch. ${numStr} ${(tr.name || "").trim()}`;
                }

                let scanlator = tr.group?.name || "";
                const gid = tr.group?._id || "";
                // If the group id isn't a 24-char hash, it's a source name — append it.
                if (gid && !/^[a-z0-9]{24}$/.test(gid)) scanlator += ` (${gid})`;

                chapters.push({
                    name: name.trim(),
                    url: tr.id,
                    scanlator: scanlator.trim(),
                    dateUpload: this.parseDate(tr.date),
                    _num: typeof number === "number" ? number : parseFloat(number) || 0
                });
            }
        }

        chapters.sort((a, b) => b._num - a._num);
        for (const c of chapters) delete c._num;
        return chapters;
    }

    parseDate(value) {
        if (!value) return "0";
        // Format: "yyyy-MM-dd HH:mm:ss" (UTC). Normalise to ISO for Date.parse.
        const iso = `${value}`.replace(" ", "T") + "Z";
        const t = Date.parse(iso);
        return isNaN(t) ? "0" : `${t}`;
    }

    // ---- Pages ---------------------------------------------------------
    async getPageList(url) {
        // `url` is the chapter translation id.
        const res = await this.client.get(
            `${this.source.baseUrl}/chapter-detail/${url}/`,
            this.baseHeaders()
        );
        const body = res.body;

        // Images are embedded as: const chapterImages = JSON.parse(`[...]`)
        const m = body.match(/const\s+chapterImages\s*=\s*JSON\.parse\(`([^`]+)`\)/);
        if (!m) return [];
        let arr;
        try {
            arr = JSON.parse(m[1]);
        } catch (e) {
            // The backtick content is itself a JSON string literal; unescape.
            arr = JSON.parse(m[1].replace(/\\"/g, '"'));
        }
        return Array.isArray(arr) ? arr : [];
    }

    getFilterList() {
        return [];
    }

    getSourcePreferences() {
        return [];
    }
}
