const mangayomiSources = [
    {
        "name": "MangaK",
        "lang": "en",
        "baseUrl": "https://mangak.io",
        "apiUrl": "https://api.mangak.io",
        "iconUrl": "https://www.google.com/s2/favicons?sz=128&domain=https://mangak.io",
        "typeSource": "single",
        "itemType": 0,
        "isNsfw": false,
        "version": "0.0.1",
        "pkgPath": "manga/src/en/mangak.js"
    }
];

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client();
    }

    getHeaders(url) {
        return {
            "Origin": this.source.baseUrl,
            "Referer": `${this.source.baseUrl}/`,
            "Accept": "application/json"
        };
    }

    safeJson(body) {
        try {
            return JSON.parse(body);
        } catch (e) {
            throw new Error("Unexpected non-JSON response from MangaK.");
        }
    }

    // ---- Listing / search (REST API) -----------------------------------
    // GET {apiUrl}/titles/search?sort=&page=&limit=&q=&genres=&exclude=...
    // Response: { data: { items: [{id,name,cover,url}], pagination: {has_next} } }
    async apiSearch(params) {
        const qs = Object.keys(params)
            .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== "")
            .map(k => `${k}=${encodeURIComponent(params[k])}`)
            .join("&");
        const res = await this.client.get(
            `${this.source.apiUrl}/titles/search?${qs}`,
            this.getHeaders()
        );
        const dto = this.safeJson(res.body);
        const data = dto.data || {};
        const items = data.items || [];

        const list = items
            .filter(it => it && it.id)
            .map(it => ({
                name: it.name || "",
                imageUrl: it.cover || "",
                // Keep the id appended after '#' so chapter lookups can use it
                // without needing a second details request.
                link: `${it.url}#${it.id}`
            }));

        const hasNextPage = !!(data.pagination && data.pagination.has_next);
        return { list, hasNextPage };
    }

    async getPopular(page) {
        return await this.apiSearch({
            sort: "popular",
            window: "week",
            page: page,
            limit: 24
        });
    }

    async getLatestUpdates(page) {
        return await this.apiSearch({
            sort: "latest",
            page: page,
            limit: 24
        });
    }

    async search(query, page, filterList) {
        const params = { page: page, limit: 24 };

        if (query && query.trim()) {
            // The API only accepts alphanumerics/spaces, max 50 chars.
            params.q = query
                .split("")
                .filter(c => /[a-zA-Z0-9 ]/.test(c))
                .join("")
                .trim()
                .slice(0, 50);
        }

        const included = [];
        const excluded = [];
        if (filterList) {
            for (const filter of filterList) {
                if (filter.type === "SortFilter" && filter.values) {
                    const v = filter.values[filter.state]?.value;
                    if (v) params.sort = v;
                } else if (filter.type === "StatusFilter" && filter.values) {
                    const v = filter.values[filter.state]?.value;
                    if (v) params.status = v;
                } else if (filter.type === "TypeFilter" && filter.values) {
                    const v = filter.values[filter.state]?.value;
                    if (v) params.type = v;
                } else if (filter.type === "GenreList" && filter.state) {
                    for (const g of filter.state) {
                        if (g.state === 1) included.push(g.value);
                        else if (g.state === 2) excluded.push(g.value);
                    }
                }
            }
        }
        if (included.length) params.genres = included.join(",");
        if (excluded.length) params.exclude = excluded.join(",");

        return await this.apiSearch(params);
    }

    // ---- Details (Next.js hydration payload) ---------------------------
    // The manga page embeds its data in __NEXT_DATA__ as JSON.
    extractNextData(body) {
        const m = `${body}`.match(
            /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/
        );
        if (!m) throw new Error("Could not find page data.");
        return JSON.parse(m[1]);
    }

    // Walk the Next.js payload to find the object holding pageProps.
    findPageProps(next) {
        if (next && next.props && next.props.pageProps) return next.props.pageProps;
        if (next && next.pageProps) return next.pageProps;
        throw new Error("Could not find page data.");
    }

    mangaUrl(link) {
        // link is "<path>#<id>"; strip the id fragment for the page URL.
        const path = `${link}`.split("#")[0];
        if (path.startsWith("http")) return path;
        return `${this.source.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    }

    async getDetail(url) {
        const res = await this.client.get(this.mangaUrl(url), this.getHeaders());
        const props = this.findPageProps(this.extractNextData(res.body));
        const m = props.initialManga;
        if (!m) throw new Error("Could not find manga details.");

        const names = (v) => Array.isArray(v)
            ? v.map(x => (x && x.name) || "").filter(Boolean)
            : [];

        const manga = {};
        manga.imageUrl = m.cover || "";
        const authors = names(m.authors);
        if (authors.length) manga.author = authors.join(", ");
        manga.genre = names(m.genres);
        manga.status = this.mapStatus(m.status);

        // Keep the id in the description so chapters can be fetched even if the
        // stored link ever loses its '#id' fragment.
        let desc = "";
        if (m.summary && `${m.summary}`.trim()) desc += `${m.summary}`.trim() + "\n\n";
        desc += `Manga ID: ${m.id}`;
        manga.description = desc;

        manga.chapters = await this.fetchChapters(m.id);
        return manga;
    }

    mapStatus(status) {
        switch ((status || "").toLowerCase()) {
            case "ongoing": return 0;
            case "completed": return 1;
            case "hiatus": return 2;
            case "cancelled":
            case "canceled": return 3;
            default: return 5;
        }
    }

    // ---- Chapters ------------------------------------------------------
    // GET {apiUrl}/titles/{id}/chapters
    // Response: { data: { chapters: [{url,name,updated_at,chapter_number}] } }
    async fetchChapters(id) {
        const res = await this.client.get(
            `${this.source.apiUrl}/titles/${id}/chapters?cv=${Date.now()}`,
            this.getHeaders()
        );
        const dto = this.safeJson(res.body);
        const raw = (dto.data && dto.data.chapters) || [];

        const chapters = raw.map(ch => ({
            name: ch.name || "",
            url: ch.url,
            scanlator: "",
            dateUpload: this.parseDate(ch.updated_at),
            _num: typeof ch.chapter_number === "number"
                ? ch.chapter_number
                : parseFloat(ch.chapter_number) || 0
        }));

        // The site uses chapter_number as its canonical ordering index.
        chapters.sort((a, b) => b._num - a._num);
        for (const c of chapters) delete c._num;
        return chapters;
    }

    parseDate(value) {
        if (!value) return "0";
        const t = Date.parse(`${value}`);
        return isNaN(t) ? "0" : `${t}`;
    }

    // ---- Pages ---------------------------------------------------------
    // The reader page embeds its image list in the Next.js payload.
    async getPageList(url) {
        const path = `${url}`.startsWith("http")
            ? `${url}`
            : `${this.source.baseUrl}${`${url}`.startsWith("/") ? "" : "/"}${url}`;
        const res = await this.client.get(path, this.getHeaders());
        const props = this.findPageProps(this.extractNextData(res.body));
        const images = (props.initialChapter && props.initialChapter.images) || [];
        return images.map(u => this.imageWithFallback(u));
    }

    // The primary image CDN (rx.qvzr?.org) sometimes 5xxs; the site falls back
    // to rx.rzyn.net. We can't intercept failures here, so images are returned
    // as-is; if a chapter fails to load, the fallback host is the known mirror.
    imageWithFallback(u) {
        return `${u}`;
    }

    // ---- Filters -------------------------------------------------------
    getFilterList() {
        const sel = (arr) =>
            arr.map(x => ({ type_name: "SelectOption", name: x[0], value: x[1] }));

        return [
            {
                type_name: "SelectFilter",
                type: "SortFilter",
                name: "Sort",
                state: 0,
                values: sel([
                    ["Popular", "popular"],
                    ["Latest", "latest"],
                    ["Newest", "newest"],
                    ["Rating", "rating"]
                ])
            },
            {
                type_name: "SelectFilter",
                type: "StatusFilter",
                name: "Status",
                state: 0,
                values: sel([
                    ["Any", ""],
                    ["Ongoing", "ongoing"],
                    ["Completed", "completed"],
                    ["Hiatus", "hiatus"],
                    ["Cancelled", "cancelled"]
                ])
            },
            {
                type_name: "SelectFilter",
                type: "TypeFilter",
                name: "Type",
                state: 0,
                values: sel([
                    ["Any", ""],
                    ["Manga", "manga"],
                    ["Manhwa", "manhwa"],
                    ["Manhua", "manhua"]
                ])
            }
        ];
    }

    getSourcePreferences() {
        return [];
    }
}
