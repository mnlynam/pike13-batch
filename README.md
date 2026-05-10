# pike13-batch

Bookmarklet for bulk-editing Pike13 product configuration. Modern successor to `batchPike`.

**Status:** v1 — supports **Services** (Appointment / GroupClass / Course). Plan / Pass / Prepaid / Retail land in v1.x.

---

## Install

Drag this to your bookmarks bar (or copy and create a new bookmark with this URL):

```
javascript:(()=>{var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/mnlynam/pike13-batch@latest/dist/pike13-batch.js?'+Date.now();document.body.appendChild(s);})();
```

The `?+Date.now()` defeats jsdelivr's edge cache so iteration is live. For stable use, pin a version: `@v1.1.0`.

---

## Usage

1. Sign in to your Pike13 desk (e.g. `musicplace.pike13.com`, `aeg.pike13.com`).
2. Click the bookmarklet from any page. A panel appears top-right.
3. **Filter** the catalog (type / category / name).
4. **Pick** a reference item to harvest fields from, or switch to **Raw mode** to write the push payload as JSON.
5. Click **Test** — required dry-run that renders the resolved POST body for the first 3 matched items without submitting.
6. Click **Apply** — POSTs each item, with per-item ✓/✗/⚠ status. Default is sequential (one at a time); flip the **Fast** toggle for parallel-3.

The panel persists during apply so you can watch progress and download a JSON report at the end.

---

## What v1 covers

- **Service-type editing** for all three subtypes — Appointment, GroupClass, Course
- Filter by type + category + name (regex toggle)
- Field picker and raw JSON mode
- Mandatory dry-run before apply
- Per-form CSRF (no stale-token bug)
- Auto subdomain detection (works on any Pike13 tenant)
- Round-trip safety (preserves untouched fields)
- 302/`opaqueredirect` success detection (no mixed-content blocks)
- Sequential default + Fast mode toggle
- Downloadable result report

## What's not in v1 (planned for v1.x)

- Plan, Pass, Prepaid, Retail product types
- Service category membership editing (move services between categories)
- Pre-flight check for `revenue_category_id` on plan price changes (silent-skip propagation trap)
- Bookmarkable filter+payload presets

## Comparison vs original batchPike

| | batchPike | pike13-batch |
|---|---|---|
| Service catalog | static `assets.js` (99KB) | live `/api/v2/desk/services` |
| CSRF | static, in `settings.js` | per-form, scraped per item |
| Subdomain | hardcoded `musicplace` | auto-detect from `location.hostname` |
| Push field IDs | hand-typed in `settings.js` | picked from live edit form |
| Status feedback | none (iframe form post) | ✓/✗/⚠ per item via `fetch` status |
| Related-record IDs | `+1` heuristic | scraped from each item's edit form |
| Reset between runs | requires page reload | built-in reset button |

## Hosting

- Source: this repo
- CDN: `cdn.jsdelivr.net/gh/mnlynam/pike13-batch@latest/dist/pike13-batch.js`
- Versioned: `cdn.jsdelivr.net/gh/mnlynam/pike13-batch@v1.1.0/dist/pike13-batch.js`

jsdelivr serves GitHub content with the right MIME type and edge cache. raw.githubusercontent.com does not.

## Development

Single-file vanilla JS, no build step. Edit `src/pike13-batch.js`, copy to `dist/`, commit. The bookmarklet picks up changes after one cache miss (the `?+Date.now()` query string ensures fresh fetch per click).

## License

Internal tooling for The Music Place / AEG. No license declared.
