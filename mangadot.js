const mangayomiSources = [
    {
        "name": "MangaDot",
        "lang": "en",
        "baseUrl": "https://mangadot.net",
        "apiUrl": "https://mangadot.net/api",
        "iconUrl": "https://mangadot.net/favicon.ico",
        "typeSource": "single",
        "itemType": 0,
        "isNsfw": false,
        "version": "0.0.1",
        "pkgPath": "manga/src/en/mangadot.js"
    }
];

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client();
    }

    getHeaders(url) {
        return {
            "Referer": `${this.source.baseUrl}/`,
            "x-requested-with": "XMLHttpRequest",
            "Accept": "application/json"
            // No User-Agent override: Cloudflare binds the cf_clearance cookie
            // to the UA that solved the challenge (Mangayomi's webview). Letting
            // the client send its default UA keeps requests consistent with the
            // cookie, avoiding 403s after a successful webview bypass.
        };
    }

    ll(url) {
        return url.includes("?") ? "&" : "?";
    }

    absUrl(path) {
        if (!path) return "";
        if (path.startsWith("http")) return path;
        return `${this.source.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    }

    // ---- Status mapping -------------------------------------------------
    // Mangayomi status ints: 0 ongoing, 1 completed, 2 hiatus, 3 cancelled, 5 unknown
    mapStatus(status) {
        const s = (status || "").toString().toLowerCase();
        if (s.includes("ongoing") || s.includes("releasing")) return 0;
        if (s.includes("completed") || s.includes("finished")) return 1;
        if (s.includes("hiatus")) return 2;
        if (s.includes("cancelled") || s.includes("canceled") || s.includes("dropped")) return 3;
        return 5;
    }

    // ---- Listing + search ----------------------------------------------
    // Everything runs through /api/search, which returns clean JSON:
    //   { "manga_list": [ { id, title, photo, genres, status, ... }, ... ],
    //     "total_results": N, "per_page": P, "page": X }
    // The endpoint accepts a query (q), pagination (page, perPage) and sorting
    // (sortBy, sortOrder), so browse and title-search share one code path.
    async apiSearch(params) {
        const qs = Object.keys(params)
            .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== "")
            .map(k => `${k}=${encodeURIComponent(params[k])}`)
            .join("&");
        const url = `${this.source.apiUrl}/search?${qs}`;
        const res = await this.client.get(url, this.getHeaders());
        return this.mangaListRes(res.body);
    }

    async getPopular(page) {
        // "Most tracked / most viewed" style ordering for a popular feed.
        return await this.apiSearch({
            sortBy: "views",
            sortOrder: "desc",
            perPage: 30,
            page: page
        });
    }

    async getLatestUpdates(page) {
        return await this.apiSearch({
            sortBy: "last_chapter_date",
            sortOrder: "desc",
            perPage: 30,
            page: page
        });
    }

    async search(query, page, filterList) {
        const params = { perPage: 30, page: page };

        if (query && query.trim().length > 0) {
            params.q = query.trim();
            params.sortBy = "relevance";
        } else {
            // No query: browse using the sort chosen in filters.
            let sortBy = "last_chapter_date";
            if (filterList) {
                for (const filter of filterList) {
                    if (filter.type === "SortFilter") {
                        sortBy = filter.values[filter.state].value;
                    }
                }
            }
            params.sortBy = sortBy;
            params.sortOrder = "desc";
        }

        return await this.apiSearch(params);
    }

    // ---- Detail --------------------------------------------------------
    async getDetail(url) {
        // `url` is the manga path we stored at list time, e.g. "/manga/166"
        const mangaId = url.split("/").filter(Boolean).pop();

        const infoRes = await this.client.get(
            `${this.source.apiUrl}/manga/${mangaId}/`,
            this.getHeaders()
        );
        const infoData = JSON.parse(infoRes.body);
        const m = infoData.manga ?? infoData;

        const manga = {};
        manga.imageUrl = this.absUrl(m.photo);
        manga.description = this.stripHtml(m.description || "");

        const authors = this.toList(m.authors);
        const artists = this.toList(m.artists);
        const people = [...new Set([...authors, ...artists])];
        if (people.length) manga.author = authors.join(", ");
        if (artists.length) manga.artist = artists.join(", ");

        let genres = this.toList(m.genres);
        if (m.content_rating && m.content_rating !== "safe") {
            genres.push(m.content_rating);
        }
        manga.genre = genres;

        manga.status = this.mapStatus(
            (m.hiatus === "Yes" || m.hiatus === true) ? "hiatus" : m.status
        );

        manga.chapters = await this.fetchChapters(mangaId);
        return manga;
    }

    async fetchChapters(mangaId) {
        const res = await this.client.get(
            `${this.source.apiUrl}/manga/${mangaId}/chapters/list`,
            this.getHeaders()
        );
        let raw = JSON.parse(res.body);
        // Endpoint may return a bare array or wrap it under `chapters`.
        if (!Array.isArray(raw)) raw = raw.chapters ?? [];

        // Only English chapters for this single-language source. Deduplicate
        // by chapter number, keeping the first (site returns newest-first).
        const seen = new Set();
        const chapters = [];
        for (const ch of raw) {
            const lang = (ch.language || "en").toLowerCase();
            if (lang !== "en") continue;

            const num = ch.chapter_number;
            const vol = ch.volume_number;
            const key = `${vol ?? ""}-${num}`;
            if (seen.has(key)) continue;
            seen.add(key);

            chapters.push({
                name: this.chapterName(vol, num, ch.chapter_title),
                url: `${ch.id}`,
                scanlator: ch.group_name || ch.scanlator_name || "",
                dateUpload: this.parseDate(ch.date_added)
            });
        }
        return chapters;
    }

    chapterName(vol, chap, title) {
        let result = "";
        if (vol !== null && vol !== undefined && `${vol}`.trim() !== "") {
            result += `Vol. ${vol} `;
        }
        if (chap !== null && chap !== undefined && `${chap}`.trim() !== "") {
            result += `Ch. ${chap}`;
        }
        if (title && `${title}`.trim() !== "") {
            result += result ? ` : ${title}` : title;
        }
        return result.trim() || "Chapter";
    }

    // ---- Pages ---------------------------------------------------------
    async getPageList(url) {
        // `url` is the chapter id we stored in fetchChapters.
        const res = await this.client.get(
            `${this.source.apiUrl}/uploads/${url}/images`,
            this.getHeaders()
        );
        const data = JSON.parse(res.body);
        const images = data.images ?? [];
        return images.map(img => this.absUrl(img.url));
    }

    // ---- Response parsing helpers --------------------------------------
    mangaListRes(body) {
        let data;
        try {
            data = JSON.parse(body);
        } catch (e) {
            return { list: [], hasNextPage: false };
        }

        // /api/search returns { manga_list: [...], total_results, per_page, page }
        let items =
            data.manga_list ??
            data.results ??
            data.manga ??
            data.data ??
            (Array.isArray(data) ? data : []);
        if (!Array.isArray(items)) items = [];

        const list = items
            .map(it => this.toMangaCard(it))
            .filter(x => x && x.link);

        // Compute pagination from totals when present; else infer from batch size.
        let hasNextPage;
        const total = Number(data.total_results);
        const perPage = Number(data.per_page);
        const page = Number(data.page);
        if (!isNaN(total) && !isNaN(perPage) && !isNaN(page) && perPage > 0) {
            hasNextPage = page * perPage < total;
        } else {
            hasNextPage = list.length >= 20;
        }
        return { list, hasNextPage };
    }

    toMangaCard(it) {
        if (!it || typeof it !== "object") return null;
        const id = it.id ?? it.manga_id;
        if (id === undefined || id === null) return null;
        const cover = it.photo ?? it.cover_url ?? it.image ?? "";
        return {
            name: it.title ?? it.name ?? "",
            imageUrl: this.absUrl(cover),
            link: `/manga/${id}`
        };
    }

    // ---- Small utilities -----------------------------------------------
    toList(value) {
        if (Array.isArray(value)) return value.map(v => `${v}`);
        if (typeof value === "string") {
            const s = value.trim();
            if (s.startsWith("[")) {
                try {
                    const parsed = JSON.parse(s);
                    if (Array.isArray(parsed)) return parsed.map(v => `${v}`);
                } catch (e) { /* fall through */ }
            }
            if (s.length) return [s];
        }
        return [];
    }

    stripHtml(str) {
        return `${str}`
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&")
            .replace(/&#8217;/g, "\u2019")
            .replace(/&#x27;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&nbsp;/g, " ")
            .trim();
    }

    parseDate(value) {
        if (!value) return "0";
        const t = Date.parse(value);
        return isNaN(t) ? "0" : `${t}`;
    }

    // ---- Filters -------------------------------------------------------
    getFilterList() {
        return [
            {
                type_name: "HeaderFilter",
                name: "Filters apply only when the search box is empty"
            },
            {
                type_name: "SelectFilter",
                type: "SortFilter",
                name: "Browse",
                state: 0,
                values: [
                    ["Latest Updates", "last_chapter_date"],
                    ["Recently Added", "date_added"],
                    ["Most Viewed", "views"],
                    ["Rating", "avg_rating"],
                    ["Title (A-Z)", "title"]
                ].map(x => ({ type_name: "SelectOption", name: x[0], value: x[1] }))
            }
        ];
    }

    getSourcePreferences() {
        return [];
    }
}
