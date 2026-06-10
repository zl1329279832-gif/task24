/* ============================================================
   utils.js  –  Shared utility functions
   ============================================================ */
const Utils = (() => {
    // Date parsing: handle yyyy-mm-dd, yyyy/mm/dd, dd-mm-yyyy, dd/mm/yyyy, mm/dd/yyyy, yyyymmdd, Chinese yyyy年mm月dd日
    function parseDate(str) {
        if (!str || typeof str !== 'string') return null;
        str = str.trim();
        if (!str) return null;

        let m;
        // yyyy-mm-dd or yyyy/mm/dd
        if ((m = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) {
            return _mkDate(+m[1], +m[2], +m[3]);
        }
        // dd-mm-yyyy or dd/mm/yyyy (day > 12 disambiguates)
        if ((m = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/))) {
            const a = +m[1], b = +m[2], y = +m[3];
            if (a > 12) return _mkDate(y, b, a);       // dd-mm-yyyy
            if (b > 12) return _mkDate(y, a, b);       // mm-dd-yyyy
            return _mkDate(y, b, a);                    // ambiguous, assume dd-mm-yyyy
        }
        // yyyymmdd
        if ((m = str.match(/^(\d{4})(\d{2})(\d{2})$/))) {
            return _mkDate(+m[1], +m[2], +m[3]);
        }
        // yyyy年mm月dd日
        if ((m = str.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/))) {
            return _mkDate(+m[1], +m[2], +m[3]);
        }
        // Fallback: try native parser
        const d = new Date(str);
        return isNaN(d.getTime()) ? null : d;
    }

    function _mkDate(y, mo, d) {
        const dt = new Date(y, mo - 1, d);
        if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d) return dt;
        return null;
    }

    function formatDate(d) {
        if (!d) return '';
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function daysBetween(a, b) {
        if (!a || !b) return 0;
        return Math.round((b - a) / 86400000);
    }

    function addDays(d, n) {
        const r = new Date(d);
        r.setDate(r.getDate() + n);
        return r;
    }

    function today() {
        const d = new Date();
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

    function uid() { return 'id_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

    function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

    function debounce(fn, ms) {
        let t;
        return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    }

    function throttle(fn, ms) {
        let last = 0;
        return (...args) => {
            const now = Date.now();
            if (now - last >= ms) { last = now; fn(...args); }
        };
    }

    function showToast(msg, type = 'info', duration = 3000) {
        const c = document.getElementById('toast-container');
        const t = document.createElement('div');
        t.className = `toast toast-${type}`;
        t.textContent = msg;
        c.appendChild(t);
        setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, duration);
    }

    function createSVGElement(tag, attrs = {}) {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        return el;
    }

    // Serialize dates for JSON (save/load)
    function serializeDates(obj) {
        return JSON.parse(JSON.stringify(obj, (k, v) => {
            if (v instanceof Date) return { __date__: v.toISOString() };
            return v;
        }));
    }

    function deserializeDates(obj) {
        return JSON.parse(JSON.stringify(obj), (k, v) => {
            if (v && typeof v === 'object' && v.__date__) return new Date(v.__date__);
            return v;
        });
    }

    return {
        parseDate, formatDate, daysBetween, addDays, today, clamp, uid,
        deepClone, debounce, throttle, showToast, createSVGElement,
        serializeDates, deserializeDates
    };
})();
