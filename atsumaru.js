const mangayomiSources = [
    {
        "name": "Atsumaru",
        "lang": "en",
        "baseUrl": "https://atsu.moe",
        "apiUrl": "https://atsu.moe",
        "iconUrl": "https://atsu.moe/favicon.ico",
        "typeSource": "single",
        "itemType": 0,
        "isNsfw": false,
        "version": "0.0.1",
        "pkgPath": "manga/src/en/atsumaru.js"
    }
];

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client();
    }

    getHeaders(url) {
        return {
            "Accept": "*/*",
            "Referer": `${this.source.baseUrl}/`,
            "Content-Type": "application/json"
        };
    }

    // Adult mode toggle from preferences.
    get18Mode() {
        try {
            const on = this.getPreferenceValue("pref_18_mode");
            return on ? "&adult=1" : "";
        } catch (e) {
            return "";
        }
    }

    // Normalise any image path into an absolute https URL.
    imageUrl(path) {
        if (!path) return "";
        let p = `${path}`;
        if (p.startsWith("http")) return p.replace(/^https?:?\/\//, "https://");
        if (p.startsWith("//")) return `https:${p}`;
        p = p.replace(/^\//, "").replace(/^static\//, "");
        return `${this.source.baseUrl}/static/${p}`;
    }

    // ---- Manga card mapping (shared by browse + search) ----------------
    toManga(it) {
        if (!it || typeof it !== "object") return null;
        const id = it.id;
        if (!id) return null;

        // imagePath comes as "poster" or "image", either a string or object.
        let img = it.poster ?? it.image ?? it.imagePath ?? "";
        if (img && typeof img === "object") img = img.image ?? "";

        return {
            name: it.title ?? "",
            imageUrl: this.imageUrl(img),
            link: `${id}`
        };
    }

    listFromItems(items) {
        return (items || [])
            .map(it => this.toManga(it))
            .filter(x => x && x.link);
    }

    // ---- Browse: trending / recently updated ---------------------------
    async getPopular(page) {
        const p = (parseInt(page) || 1) - 1;
        const url = `${this.source.apiUrl}/api/infinite/trending?page=${p}&types=Manga,Manwha,Manhua,OEL${this.get18Mode()}`;
        const res = await this.client.get(url, this.getHeaders());
        const data = JSON.parse(res.body);
        return { list: this.listFromItems(data.items), hasNextPage: true };
    }

    async getLatestUpdates(page) {
        const p = (parseInt(page) || 1) - 1;
        const url = `${this.source.apiUrl}/api/infinite/recentlyUpdated?page=${p}&types=Manga,Manwha,Manhua,OEL${this.get18Mode()}`;
        const res = await this.client.get(url, this.getHeaders());
        const data = JSON.parse(res.body);
        return { list: this.listFromItems(data.items), hasNextPage: true };
    }

    // ---- Search (Typesense collection endpoint) ------------------------
    async search(query, page, filterList) {
        const showAdult = this.get18Mode().length > 0;

        const filterBy = [
            "hidden:!=true",
            "(mbContentRating:=[`Safe`,`Suggestive`,`Erotica`] || mbContentRating:!=*)",
            "views:>0"
        ];
        if (!showAdult) filterBy.push("isAdult:=false");

        const params = [
            `q=${encodeURIComponent(query && query.trim() ? query.trim() : "*")}`,
            `filter_by=${encodeURIComponent(filterBy.join(" && "))}`,
            `page=${parseInt(page) || 1}`,
            `per_page=40`
        ];
        if (query && query.trim()) {
            params.push(`query_by=${encodeURIComponent("title,englishTitle,otherNames,authors")}`);
            params.push(`query_by_weights=${encodeURIComponent("4,3,2,1")}`);
            params.push(`num_typos=${encodeURIComponent("4,3,2,1")}`);
        }

        const url = `${this.source.baseUrl}/collections/manga/documents/search?${params.join("&")}`;
        const res = await this.client.get(url, this.getHeaders());
        const body = res.body;

        if (body.includes('"hits"')) {
            const data = JSON.parse(body);
            const list = (data.hits || [])
                .map(h => this.toManga(h.document))
                .filter(x => x && x.link);
            const found = Number(data.found) || 0;
            const perPage = (data.request_params && Number(data.request_params.per_page)) || 40;
            const pg = Number(data.page) || 1;
            return { list, hasNextPage: pg * perPage < found };
        }

        // Fallback: some deployments return the browse shape.
        const data = JSON.parse(body);
        return { list: this.listFromItems(data.items), hasNextPage: true };
    }

    // ---- Details -------------------------------------------------------
    async getDetail(url) {
        const id = url;
        const res = await this.client.get(
            `${this.source.apiUrl}/api/manga/page?id=${id}`,
            this.getHeaders()
        );
        const m = JSON.parse(res.body).mangaPage;

        const manga = {};

        let img = m.poster ?? m.image ?? "";
        if (img && typeof img === "object") img = img.image ?? "";
        manga.imageUrl = this.imageUrl(img);

        // Authors: array of strings or {name, type} objects.
        const authors = [];
        const artists = [];
        if (Array.isArray(m.authors)) {
            for (const a of m.authors) {
                if (typeof a === "string") authors.push(a);
                else if (a && typeof a === "object" && a.name) {
                    if (a.type === "Artist") artists.push(a.name);
                    else authors.push(a.name);
                }
            }
        }
        if (authors.length) manga.author = authors.join(", ");
        if (artists.length) manga.artist = artists.join(", ");

        // Genre = type + genre/tag names.
        const names = (v) => Array.isArray(v)
            ? v.map(x => typeof x === "string" ? x : (x && x.name) || "").filter(Boolean)
            : [];
        const genres = [];
        if (m.type) genres.push(m.type);
        genres.push(...names(m.genres));
        genres.push(...names(m.tags));
        manga.genre = genres;

        // Description with a few extra fields.
        const parts = [];
        if (m.avgRating && m.avgRating > 0) parts.push(`Rating: ${m.avgRating.toFixed(2)}/10`);
        if (m.released && m.released > 0) {
            const y = new Date(m.released).getFullYear();
            if (y) parts.push(`Year: ${y}`);
        }
        if (m.synopsis && m.synopsis.trim()) parts.push(m.synopsis.trim());
        if (Array.isArray(m.otherNames)) {
            const alts = m.otherNames.filter(n => n && n !== m.title);
            if (alts.length) parts.push("Alternative Names:\n" + alts.map(n => `- ${n}`).join("\n"));
        }
        manga.description = parts.join("\n\n");

        manga.status = this.mapStatus(m.status);
        manga.chapters = await this.fetchChapters(id, m.scanlators);
        return manga;
    }

    mapStatus(status) {
        switch ((status || "").toLowerCase().trim()) {
            case "ongoing": return 0;
            case "completed": return 1;
            case "hiatus": return 2;
            case "canceled":
            case "cancelled": return 3;
            default: return 5;
        }
    }

    // ---- Chapters ------------------------------------------------------
    async fetchChapters(mangaId, scanlators) {
        // Build scanlator id -> name map from the details payload.
        const scanMap = {};
        if (Array.isArray(scanlators)) {
            for (const s of scanlators) {
                if (s && s.id) scanMap[s.id] = s.name;
            }
        }

        const res = await this.client.get(
            `${this.source.apiUrl}/api/manga/allChapters?mangaId=${mangaId}`,
            this.getHeaders()
        );
        const data = JSON.parse(res.body);
        const raw = data.chapters || [];

        const chapters = raw.map(ch => {
            const scanName = ch.scanlationMangaId ? scanMap[ch.scanlationMangaId] : null;
            return {
                name: ch.title || `Chapter ${ch.number}`,
                url: `${mangaId}/${ch.id}`,
                scanlator: scanName || "",
                dateUpload: this.parseDate(ch.createdAt),
                _num: typeof ch.number === "number" ? ch.number : parseFloat(ch.number) || 0
            };
        });

        // Sort newest chapter first.
        chapters.sort((a, b) => b._num - a._num);
        for (const c of chapters) delete c._num;
        return chapters;
    }

    parseDate(value) {
        if (value === undefined || value === null) return "0";
        if (typeof value === "number") return `${value}`;
        const t = Date.parse(`${value}`.replace("T ", "T"));
        return isNaN(t) ? "0" : `${t}`;
    }

    // ---- Pages ---------------------------------------------------------
    async getPageList(url) {
        const parts = url.split("/");
        const slug = parts[0];
        const name = parts[1];
        const res = await this.client.get(
            `${this.source.apiUrl}/api/read/chapter?mangaId=${slug}&chapterId=${name}`,
            this.getHeaders()
        );
        const pages = JSON.parse(res.body).readChapter.pages || [];
        return pages.map(p => {
            let img = p.image;
            if (img.startsWith("http")) img = img.replace(/^https?:?\/\//, "https://");
            else if (img.startsWith("//")) img = `https:${img}`;
            else img = `${this.source.baseUrl}/static/${img.replace(/^\//, "").replace(/^static\//, "")}`;
            return img;
        });
    }

    // ---- Filters + preferences -----------------------------------------
    getFilterList() {
        return [];
    }

    getSourcePreferences() {
        return [
            {
                key: "pref_18_mode",
                switchPreferenceCompat: {
                    title: "Toggle adult mode",
                    summary: "Show +18 content (off by default)",
                    value: false
                }
            }
        ];
    }
}
