/* pike13-batch v1.1.0
 *
 * Bookmarklet for bulk-editing Pike13 product configuration.
 * v1 supports Service type (Appointment / GroupClass / Course).
 *
 * Loaded via:
 *   javascript:(()=>{var s=document.createElement('script');
 *     s.src='https://cdn.jsdelivr.net/gh/mnlynam/pike13-batch@latest/dist/pike13-batch.js?'+Date.now();
 *     document.body.appendChild(s);})();
 */
(function pike13Batch() {
  'use strict';

  // ============================================================
  // Bootstrap: page check + idempotent toggle
  // ============================================================
  if (!/\.pike13\.com$/i.test(location.hostname)) {
    alert('pike13-batch must be loaded on a *.pike13.com page.');
    return;
  }
  const HOST_ID = 'pike13-batch-host';
  const existing = document.getElementById(HOST_ID);
  if (existing) { existing.remove(); return; }   // re-click closes

  const SUBDOMAIN = location.hostname.split('.')[0];

  // ============================================================
  // Service-type configuration
  // ============================================================
  const SUBTYPES = {
    Appointment: { slug: 'appointments',  prefix: 'appointment' },
    GroupClass:  { slug: 'group_classes', prefix: 'group_class' },
    Course:      { slug: 'courses',       prefix: 'course' },
  };
  const NOISE_NAMES = /^(authenticity_token|_method|utf8|button)$/;
  const NOISE_SUFFIX = /\[(_destroy)\]$/;
  // We DO want [id] for nested attributes — Pike13 needs them on round-trip.
  // We exclude only specific top-level [id] patterns we know are framework noise.

  // ============================================================
  // Pike13 API helpers
  // ============================================================
  const json = (path) => fetch(path, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  }).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json();
  });

  const html = (path) => fetch(path, {
    credentials: 'include',
    headers: { accept: 'text/html' },
  }).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.text();
  });

  async function fetchServices() {
    // /api/v2/desk/services returns {services: [...], categories: [...]}
    const data = await json('/api/v2/desk/services?per_page=2000');
    const services = data.services || [];
    const categories = data.categories || [];
    const catName = Object.fromEntries(categories.map((c) => [c.id, c.name]));
    return services.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,                          // "Appointment" | "GroupClass" | "Course"
      category_id: s.category_id,
      category_name: catName[s.category_id] || '(uncategorized)',
    }));
  }

  function editPath(svc) {
    const sub = SUBTYPES[svc.type];
    if (!sub) throw new Error(`Unknown service type: ${svc.type}`);
    return `/${sub.slug}/${svc.id}/edit`;
  }

  function postPath(svc) {
    const sub = SUBTYPES[svc.type];
    return `/${sub.slug}/${svc.id}`;
  }

  function prefixFor(svc) {
    return SUBTYPES[svc.type].prefix;
  }

  async function fetchEditForm(svc) {
    const text = await html(editPath(svc));
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const form = doc.querySelector(`form[action="${postPath(svc)}"]`)
              || doc.querySelector(`form[action^="${postPath(svc)}"]`);
    if (!form) throw new Error(`No edit form found at ${editPath(svc)}`);
    return form;
  }

  // ============================================================
  // Form field parsing
  // ============================================================
  // Returns a flat list of editable fields suitable for the picker UI.
  // Each entry: { name, type, value, options?, label }
  function parseFormFields(form, prefix) {
    const grouped = new Map();      // name -> { name, type, value, options }
    for (const el of form.querySelectorAll('input, select, textarea')) {
      const name = el.name;
      if (!name) continue;
      if (NOISE_NAMES.test(name) || NOISE_SUFFIX.test(name)) continue;
      // Skip hidden Rails idempotency markers
      if (el.type === 'hidden' && /\[id\]$/.test(name)) continue;

      const tag = el.tagName;
      let type, value, options;

      if (tag === 'SELECT') {
        type = 'select';
        value = el.value;
        options = [...el.options].map((o) => ({
          value: o.value, label: (o.textContent || '').trim(),
        }));
      } else if (el.type === 'checkbox') {
        if (!grouped.has(name) || grouped.get(name).type !== 'checkbox') {
          grouped.set(name, { name, type: 'checkbox', value: el.checked ? (el.value || '1') : '0' });
        } else if (el.checked) {
          grouped.get(name).value = el.value || '1';
        }
        continue;
      } else if (el.type === 'radio') {
        const cur = grouped.get(name);
        const opt = { value: el.value, label: el.value };
        if (cur && cur.type === 'radio') {
          cur.options.push(opt);
          if (el.checked) cur.value = el.value;
        } else {
          grouped.set(name, {
            name, type: 'radio', value: el.checked ? el.value : '', options: [opt],
          });
        }
        continue;
      } else if (el.type === 'hidden') {
        // Hidden inputs are framework state — keep value but don't surface as editable
        if (!grouped.has(name)) {
          grouped.set(name, { name, type: 'hidden', value: el.value });
        }
        continue;
      } else if (tag === 'TEXTAREA') {
        type = 'textarea';
        value = el.value;
      } else if (el.type === 'number') {
        type = 'number';
        value = el.value;
      } else {
        type = 'text';
        value = el.value;
      }

      grouped.set(name, { name, type, value, options });
    }

    // Promote: drop hidden-only entries from the picker, label everything
    const fields = [];
    for (const f of grouped.values()) {
      if (f.type === 'hidden') continue;     // not user-editable
      f.label = prettyLabel(f.name, prefix);
      fields.push(f);
    }
    fields.sort((a, b) => a.label.localeCompare(b.label));
    return fields;
  }

  function prettyLabel(name, prefix) {
    // appointment[snap_duration_in_minutes] -> "snap_duration_in_minutes"
    const m = name.match(new RegExp(`^${prefix}\\[([^\\]]+)\\](.*)$`));
    if (m) return m[1] + (m[2] || '');
    return name;
  }

  // ============================================================
  // POST body construction (round-trip + overrides)
  // ============================================================
  // Build the URLSearchParams for an item, starting from the live edit form
  // and applying the user-chosen overrides on top.
  function buildPostBody(form, overrides /* {name: value} */) {
    const fd = new FormData(form);
    // Override / add user-picked fields. set() replaces all prior values for the name.
    for (const [name, value] of Object.entries(overrides)) {
      if (Array.isArray(value)) {
        fd.delete(name);
        for (const v of value) fd.append(name, v);
      } else {
        fd.set(name, value);
      }
    }
    // FormData -> URLSearchParams (skip File entries, which we don't expect here)
    const body = new URLSearchParams();
    for (const [k, v] of fd) {
      body.append(k, typeof v === 'string' ? v : '');
    }
    return body;
  }

  // Resolve raw-mode payload keys against a service's prefix.
  // "snap_duration_in_minutes"        -> "appointment[snap_duration_in_minutes]"
  // "[snap_duration_in_minutes]"      -> "appointment[snap_duration_in_minutes]"
  // "appointment[snap_duration...]"   -> as-is
  function resolveRawKey(key, prefix) {
    if (key.startsWith(`${prefix}[`)) return key;
    if (key.startsWith('[')) return prefix + key;
    if (/^[a-z_]+\[/.test(key)) return key;        // some other prefix, leave it
    return `${prefix}[${key}]`;
  }

  // Apply the user's chosen overrides (picker selections OR raw payload)
  // for one specific service, returning {name: value} suitable for buildPostBody.
  function resolveOverrides(svc, picked /* {name: value} */, raw /* {key: value} */) {
    const prefix = prefixFor(svc);
    const out = {};
    for (const [name, value] of Object.entries(picked || {})) out[name] = value;
    for (const [key, value] of Object.entries(raw || {})) {
      out[resolveRawKey(key, prefix)] = value;
    }
    return out;
  }

  // ============================================================
  // Apply mechanics: round-trip + POST + status
  // ============================================================
  async function applyOne(svc, picked, raw) {
    const form = await fetchEditForm(svc);
    const overrides = resolveOverrides(svc, picked, raw);
    const body = buildPostBody(form, overrides);

    const res = await fetch(postPath(svc), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        accept: 'text/html',
      },
      body: body.toString(),
      redirect: 'manual',
    });
    // Pike13 returns 302 on success; with redirect:'manual' fetch surfaces opaqueredirect.
    const ok = res.type === 'opaqueredirect' || (res.status >= 200 && res.status < 400);
    return { ok, status: res.status || '(opaque)', type: res.type };
  }

  // Dry-run: same as applyOne but stops short of POST. Returns the would-be body.
  async function dryRunOne(svc, picked, raw) {
    const form = await fetchEditForm(svc);
    const overrides = resolveOverrides(svc, picked, raw);
    const body = buildPostBody(form, overrides);
    return {
      url: postPath(svc),
      overrides,
      bodyPreview: previewBody(body, overrides),
    };
  }

  function previewBody(body, overrides) {
    // Show only the override keys + a summary of the rest
    const overrideKeys = new Set(Object.keys(overrides));
    const lines = [];
    let othersCount = 0;
    for (const [k, v] of body) {
      if (overrideKeys.has(k)) {
        lines.push(`${k} = ${truncate(v, 80)}`);
      } else {
        othersCount++;
      }
    }
    lines.push(`(+ ${othersCount} preserved field${othersCount === 1 ? '' : 's'})`);
    return lines.join('\n');
  }

  function truncate(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  // ============================================================
  // State
  // ============================================================
  const state = {
    services: [],                       // raw catalog
    filter: { type: '', categoryId: '', name: '', regex: false },
    matched: [],                        // services after filter
    refSvc: null,                       // reference service whose fields are picked
    refFields: [],                      // parsed fields from refSvc edit form
    pickerSel: {},                      // {name: value}
    rawText: '',
    rawError: '',
    mode: 'picker',                     // 'picker' | 'raw'
    fast: false,                        // parallel-3 toggle
    stage: 'configure',                 // 'configure' | 'tested' | 'applying' | 'done'
    testResult: null,                   // [{svc, dry|err}]
    applyResults: [],                   // [{svc, ok, status, ...}]
  };

  // ============================================================
  // UI: Shadow DOM mount
  // ============================================================
  const host = document.createElement('div');
  host.id = HOST_ID;
  // Center on load. Drag-to-move clears `transform` and switches to absolute left/top.
  // Append to <html>, not <body>, so any CSS `zoom`/`transform` on body doesn't scale us.
  Object.assign(host.style, {
    position: 'fixed', top: '50%', left: '50%',
    transform: 'translate(-50%, -50%)',
    zIndex: '2147483647',
  });
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  const styleEl = document.createElement('style');
  styleEl.textContent = `
    /* Zoom independence: shadow DOM blocks most styling, but inheritable
       properties (font-size, color, zoom) cross the boundary. Pin them so
       Pike13's CSS zoom or font-size scaling can't shrink/grow our panel. */
    :host {
      zoom: 1 !important;
      font: 13px/1.4 -apple-system, "Segoe UI", system-ui, Arial, sans-serif !important;
      color: #222 !important;
      text-align: left !important;
    }
    :host, * { box-sizing: border-box; }
    .panel {
      width: 480px; max-height: 90vh; overflow: hidden;
      display: flex; flex-direction: column;
      background: #fff; color: #222;
      font: 13px/1.4 -apple-system, "Segoe UI", system-ui, Arial, sans-serif;
      border: 1px solid #ccc; border-radius: 6px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.18);
    }
    header {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; background: #2b3a55; color: #fff;
      cursor: move; user-select: none;
      border-radius: 6px 6px 0 0;
    }
    header .title { flex: 1; font-weight: 600; font-size: 14px; }
    header .sub { opacity: 0.7; font-size: 11px; }
    header .x {
      cursor: pointer; padding: 2px 8px; font-size: 16px;
      border-radius: 4px;
    }
    header .x:hover { background: rgba(255,255,255,0.15); }

    .body { padding: 10px; overflow: auto; flex: 1; }
    .row { display: flex; gap: 6px; align-items: center; margin: 6px 0; }
    .row > label { min-width: 80px; color: #666; font-size: 12px; }
    .row > input[type=text], .row > input[type=number], .row > select {
      flex: 1; padding: 4px 6px;
      border: 1px solid #ccc; border-radius: 3px; font: inherit;
    }
    .row > input[type=text]:focus, .row > select:focus { outline: 2px solid #4287f5; }

    .count { font-size: 12px; color: #666; margin: 4px 0 8px; }
    .count strong { color: #222; }

    .tab-row { display: flex; gap: 4px; margin: 8px 0 4px; border-bottom: 1px solid #ddd; }
    .tab { padding: 4px 10px; cursor: pointer; border-radius: 3px 3px 0 0;
           font-size: 12px; color: #666; }
    .tab.active { background: #f0f4fa; color: #222; font-weight: 600; }

    .picker { max-height: 240px; overflow: auto; border: 1px solid #ddd;
              border-radius: 3px; padding: 4px; background: #fafafa; }
    .picker .field {
      display: grid; grid-template-columns: 18px 1fr 1.4fr;
      gap: 6px; align-items: center; padding: 3px 4px;
    }
    .picker .field:hover { background: #fff; }
    .picker .field code { font-size: 11px; color: #444;
                          word-break: break-all; }
    .picker .field .remove {
      width: 18px; height: 18px; line-height: 16px;
      text-align: center; cursor: pointer; color: #999;
      border-radius: 3px; font-size: 14px; user-select: none;
    }
    .picker .field .remove:hover { background: #fdd; color: #c00; }
    .picker .field input[type=text],
    .picker .field input[type=number],
    .picker .field select,
    .picker .field textarea {
      width: 100%; padding: 4px 6px; border: 1px solid #ccc;
      border-radius: 3px; font: inherit;
    }
    .picker .field input[type=text]:focus,
    .picker .field input[type=number]:focus,
    .picker .field select:focus,
    .picker .field textarea:focus { outline: 2px solid #4287f5; }
    .picker .field textarea { min-height: 32px; resize: vertical; }
    .picker .field .ck { width: 16px; height: 16px; }

    textarea.raw { width: 100%; min-height: 120px; padding: 6px;
                   border: 1px solid #ccc; border-radius: 3px;
                   font: 12px ui-monospace, Menlo, Consolas, monospace; }
    .raw-err { color: #c00; font-size: 12px; margin-top: 4px; }

    .actions { display: flex; gap: 6px; margin-top: 10px; align-items: center; }
    .actions .spacer { flex: 1; }
    button {
      padding: 5px 12px; border: 1px solid #ccc; background: #f5f5f5;
      border-radius: 3px; cursor: pointer; font: inherit;
    }
    button:hover:not(:disabled) { background: #e8e8e8; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.primary { background: #2b3a55; color: #fff; border-color: #1d2a3e; }
    button.primary:hover:not(:disabled) { background: #1d2a3e; }
    button.danger  { background: #b8312a; color: #fff; border-color: #8b231e; }
    button.danger:hover:not(:disabled) { background: #8b231e; }

    .toggle { display: flex; align-items: center; gap: 4px;
              font-size: 12px; color: #555; cursor: pointer; user-select: none; }

    .preview { background: #f7f9fc; border: 1px solid #ddd;
               border-radius: 3px; padding: 6px; margin-top: 8px;
               font: 11px ui-monospace, Menlo, Consolas, monospace;
               white-space: pre-wrap; max-height: 200px; overflow: auto; }
    .preview h4 { margin: 0 0 2px; font-size: 11px; color: #2b3a55; }

    .results { max-height: 280px; overflow: auto;
               border: 1px solid #ddd; border-radius: 3px;
               margin-top: 8px; }
    .results .item {
      display: grid; grid-template-columns: 22px 1fr 80px;
      padding: 4px 6px; gap: 6px; align-items: center;
      border-bottom: 1px solid #eee; font-size: 12px;
    }
    .results .item:last-child { border-bottom: 0; }
    .results .item.ok    .icon { color: #1c7c25; }
    .results .item.fail  .icon { color: #c00; }
    .results .item.skip  .icon { color: #999; }
    .results .item .icon { font-weight: 700; text-align: center; }

    .progress { background: #eee; height: 6px; border-radius: 3px; overflow: hidden;
                margin: 6px 0; }
    .progress > div { background: #2b3a55; height: 100%; transition: width 200ms; }

    .countdown { background: #ffe8b3; border: 1px solid #d4a017;
                 padding: 6px 10px; margin: 8px 0; border-radius: 3px;
                 font-size: 13px; }
    .countdown button { float: right; }
  `;
  root.appendChild(styleEl);

  const panel = document.createElement('div');
  panel.className = 'panel';
  root.appendChild(panel);

  // ============================================================
  // UI: render + dispatch
  // ============================================================
  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'style') Object.assign(e.style, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        e.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'checked' || k === 'disabled' || k === 'selected') {
        if (v) e.setAttribute(k, k); else e.removeAttribute(k);
      } else if (v != null) e.setAttribute(k, v);
    }
    for (const c of (Array.isArray(children) ? children : [children])) {
      if (c == null || c === false) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  function render() {
    panel.innerHTML = '';
    panel.appendChild(renderHeader());
    const body = el('div', { class: 'body' });
    if (state.stage === 'applying' || state.stage === 'done') {
      body.appendChild(renderApplyView());
    } else {
      body.appendChild(renderFilter());
      body.appendChild(renderConfigure());
      body.appendChild(renderActions());
      if (state.testResult) body.appendChild(renderTestResult());
    }
    panel.appendChild(body);
    makeDraggable();
  }

  function renderHeader() {
    return el('header', {}, [
      el('div', { class: 'title' }, [`pike13-batch v1.1`]),
      el('div', { class: 'sub' }, [SUBDOMAIN]),
      el('div', { class: 'x', title: 'Close', onclick: close }, ['×']),
    ]);
  }

  function renderFilter() {
    const cats = uniqueCategories(state.services);
    return el('div', {}, [
      el('div', { class: 'row' }, [
        el('label', {}, ['Type']),
        el('select', { onchange: (e) => { state.filter.type = e.target.value; refilter(); render(); } }, [
          el('option', { value: '', selected: state.filter.type === '' }, ['(any)']),
          ...Object.keys(SUBTYPES).map((t) =>
            el('option', { value: t, selected: state.filter.type === t }, [t])),
        ]),
      ]),
      el('div', { class: 'row' }, [
        el('label', {}, ['Category']),
        el('select', { onchange: (e) => { state.filter.categoryId = e.target.value; refilter(); render(); } }, [
          el('option', { value: '', selected: !state.filter.categoryId }, ['(any)']),
          ...cats.map((c) =>
            el('option', { value: c.id, selected: String(state.filter.categoryId) === String(c.id) }, [c.name])),
        ]),
      ]),
      el('div', { class: 'row' }, [
        el('label', {}, ['Name']),
        el('input', {
          type: 'text', value: state.filter.name,
          placeholder: state.filter.regex ? '/regex/' : 'substring',
          oninput: (e) => { state.filter.name = e.target.value; refilter(); refreshCount(); },
        }),
        el('label', { class: 'toggle', title: 'Match name as regex' }, [
          el('input', {
            type: 'checkbox', checked: state.filter.regex,
            onchange: (e) => { state.filter.regex = e.target.checked; refilter(); render(); },
          }),
          'rgx',
        ]),
      ]),
      el('div', { class: 'count', id: 'count' }, [
        el('strong', {}, [String(state.matched.length)]),
        ` of ${state.services.length} services match`,
      ]),
    ]);
  }

  function refreshCount() {
    const c = root.getElementById?.('count') || root.querySelector('#count');
    if (!c) return;
    c.innerHTML = '';
    c.append(
      el('strong', {}, [String(state.matched.length)]),
      ` of ${state.services.length} services match`,
    );
  }

  function uniqueCategories(services) {
    const m = new Map();
    for (const s of services) m.set(s.category_id, { id: s.category_id, name: s.category_name });
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function refilter() {
    const f = state.filter;
    let rx = null;
    if (f.regex && f.name) {
      try { rx = new RegExp(f.name, 'i'); } catch (e) { rx = null; }
    }
    state.matched = state.services.filter((s) => {
      if (f.type && s.type !== f.type) return false;
      if (f.categoryId && String(s.category_id) !== String(f.categoryId)) return false;
      if (f.name) {
        if (rx) { if (!rx.test(s.name)) return false; }
        else { if (!s.name.toLowerCase().includes(f.name.toLowerCase())) return false; }
      }
      return true;
    });
    // Reset reference + test when filter changes
    if (state.refSvc && !state.matched.find((s) => s.id === state.refSvc.id)) {
      state.refSvc = null; state.refFields = []; state.pickerSel = {};
    }
    state.testResult = null;
    if (state.stage === 'tested') state.stage = 'configure';
  }

  function renderConfigure() {
    const tabs = el('div', { class: 'tab-row' }, [
      el('div', { class: 'tab' + (state.mode === 'picker' ? ' active' : ''),
                  onclick: () => { state.mode = 'picker'; state.testResult = null; render(); } }, ['Picker']),
      el('div', { class: 'tab' + (state.mode === 'raw' ? ' active' : ''),
                  onclick: () => { state.mode = 'raw'; state.testResult = null; render(); } }, ['Raw JSON']),
    ]);
    const content = state.mode === 'picker' ? renderPicker() : renderRaw();
    return el('div', {}, [tabs, content]);
  }

  function renderPicker() {
    if (state.matched.length === 0) {
      return el('div', { class: 'count' }, ['No matches — adjust filters above.']);
    }
    // Mixed-type matches need a Type filter so we know which schema to load
    const types = new Set(state.matched.map((s) => s.type));
    if (types.size > 1) {
      return el('div', { class: 'count' },
        [`Matched set contains ${types.size} service types (${[...types].join(', ')}). `,
         `Pick a Type filter above to load that subtype's fields.`]);
    }
    // Auto-load reference fields from the first matched item if not already loaded
    if (!state.refSvc || state.refSvc.id !== state.matched[0].id) {
      autoLoadFieldsFor(state.matched[0]);
    }
    if (!state.refFields.length) {
      return el('div', { class: 'count' },
        [`Loading available fields from ${state.matched[0].name}…`]);
    }
    return renderFieldList();
  }

  function renderFieldList() {
    // Available = all reference fields not already picked
    const picked = new Set(Object.keys(state.pickerSel));
    const available = state.refFields.filter((f) => !picked.has(f.name));

    const datalistId = 'pike13-batch-fields';
    const addRow = el('div', { class: 'row' }, [
      el('label', {}, ['Add field']),
      el('input', {
        type: 'text',
        list: datalistId,
        placeholder: available.length
          ? `Type to filter ${available.length} field${available.length === 1 ? '' : 's'}…`
          : 'All fields picked',
        onchange: (e) => {
          const name = e.target.value.trim();
          if (!name) return;
          const f = state.refFields.find((x) => x.name === name || x.label === name);
          if (!f) return;        // typed an unknown name — ignore
          if (f.name in state.pickerSel) return;
          state.pickerSel[f.name] = currentEditorValue(f);
          state.testResult = null;
          if (state.stage === 'tested') state.stage = 'configure';
          render();
        },
      }),
      el('datalist', { id: datalistId },
        available.map((f) => el('option', { value: f.label, label: f.name }))),
    ]);

    const selectedRows = Object.keys(state.pickerSel).map((name) => {
      const f = state.refFields.find((x) => x.name === name);
      if (!f) return null;
      return el('div', { class: 'field' }, [
        el('div', { class: 'remove', title: 'Remove this field',
                    onclick: () => {
                      delete state.pickerSel[name];
                      state.testResult = null;
                      if (state.stage === 'tested') state.stage = 'configure';
                      render();
                    } }, ['×']),
        el('code', { title: f.name }, [f.label]),
        renderEditor(f),
      ]);
    }).filter(Boolean);

    const list = selectedRows.length
      ? el('div', { class: 'picker' }, selectedRows)
      : el('div', { class: 'count' },
          [`No fields picked yet. Use the dropdown above to add one.`]);

    return el('div', {}, [addRow, list]);
  }

  function renderEditor(f) {
    const onInput = (val) => {
      if (f.name in state.pickerSel) state.pickerSel[f.name] = val;
      f.value = val;            // remember last edited
      state.testResult = null;
      if (state.stage === 'tested') state.stage = 'configure';
    };
    if (f.type === 'select' || f.type === 'radio') {
      return el('select', { onchange: (e) => onInput(e.target.value) },
        (f.options || []).map((o) =>
          el('option', { value: o.value, selected: o.value === f.value }, [o.label || o.value || '(blank)'])));
    }
    if (f.type === 'checkbox') {
      const isChecked = f.value !== '0' && f.value !== '' && f.value !== 'false';
      return el('label', { class: 'toggle' }, [
        el('input', {
          type: 'checkbox', checked: isChecked,
          onchange: (e) => onInput(e.target.checked ? '1' : '0'),
        }),
        isChecked ? 'true' : 'false',
      ]);
    }
    if (f.type === 'textarea') {
      return el('textarea', {
        oninput: (e) => onInput(e.target.value),
      }, [f.value || '']);
    }
    return el('input', {
      type: f.type === 'number' ? 'number' : 'text',
      value: f.value || '',
      oninput: (e) => onInput(e.target.value),
    });
  }

  function currentEditorValue(f) {
    if (f.type === 'checkbox') {
      return (f.value !== '0' && f.value !== '' && f.value !== 'false') ? '1' : '0';
    }
    return f.value;
  }

  // Auto-load reference fields from a service. Idempotent — guarded against
  // overlapping fetches if the user changes filters mid-flight.
  let _loadingRefId = null;
  async function autoLoadFieldsFor(svc) {
    if (_loadingRefId === svc.id) return;
    _loadingRefId = svc.id;
    // Wipe picker selections if subtype changes (prefixes won't match new schema)
    if (state.refSvc && state.refSvc.type !== svc.type) state.pickerSel = {};
    state.refSvc = svc; state.refFields = [];
    try {
      const form = await fetchEditForm(svc);
      if (_loadingRefId !== svc.id) return;     // superseded by another load
      state.refFields = parseFormFields(form, prefixFor(svc));
      render();
    } catch (e) {
      if (_loadingRefId !== svc.id) return;
      const body = panel.querySelector('.body');
      if (body) {
        body.appendChild(el('div', { class: 'count', style: { color: '#c00' } },
          [`Failed to load fields from ${svc.name}: ${e.message}`]));
      }
    } finally {
      if (_loadingRefId === svc.id) _loadingRefId = null;
    }
  }

  function renderRaw() {
    const help = `// Keys are field names (with or without the type prefix).
// Examples (all equivalent for Appointment):
//   "snap_duration_in_minutes": "15"
//   "[snap_duration_in_minutes]": "15"
//   "appointment[snap_duration_in_minutes]": "15"
// Values are strings. Arrays send multiple form values.`;
    return el('div', {}, [
      el('div', { class: 'count' }, ['Raw push payload — JSON object. Auto-prefixes by service subtype.']),
      el('textarea', {
        class: 'raw',
        placeholder: '{\n  "snap_duration_in_minutes": "15"\n}',
        oninput: (e) => {
          state.rawText = e.target.value;
          try {
            JSON.parse(e.target.value || '{}');
            state.rawError = '';
          } catch (err) {
            state.rawError = err.message;
          }
          state.testResult = null;
          if (state.stage === 'tested') state.stage = 'configure';
          // Inline error display
          const errEl = root.querySelector('.raw-err');
          if (errEl) errEl.textContent = state.rawError;
        },
      }, [state.rawText]),
      el('div', { class: 'raw-err' }, [state.rawError]),
      el('div', { class: 'count' }, [help]),
    ]);
  }

  function renderActions() {
    const ready = readyToTest();
    const canApply = state.stage === 'tested' && state.testResult
                  && state.testResult.every((r) => !r.err);
    return el('div', { class: 'actions' }, [
      el('label', { class: 'toggle', title: 'Apply 3 items in parallel' }, [
        el('input', {
          type: 'checkbox', checked: state.fast,
          onchange: (e) => { state.fast = e.target.checked; },
        }),
        'Fast (parallel-3)',
      ]),
      el('div', { class: 'spacer' }),
      el('button', { onclick: onTest, disabled: !ready }, ['Test (dry-run)']),
      el('button', { class: 'primary', onclick: onApply, disabled: !canApply }, ['Apply']),
    ]);
  }

  function readyToTest() {
    if (state.matched.length === 0) return false;
    if (state.mode === 'picker') return Object.keys(state.pickerSel).length > 0;
    if (state.mode === 'raw') {
      if (state.rawError) return false;
      try {
        const o = JSON.parse(state.rawText || '{}');
        return o && typeof o === 'object' && Object.keys(o).length > 0;
      } catch { return false; }
    }
    return false;
  }

  function getRawPayload() {
    if (state.mode !== 'raw') return {};
    try { return JSON.parse(state.rawText || '{}'); } catch { return {}; }
  }

  function getPickerPayload() {
    return state.mode === 'picker' ? { ...state.pickerSel } : {};
  }

  // ============================================================
  // Test (dry-run) — first 3 items
  // ============================================================
  async function onTest() {
    const sample = state.matched.slice(0, 3);
    const picked = getPickerPayload();
    const raw = getRawPayload();
    state.testResult = sample.map((svc) => ({ svc, dry: null, err: null, loading: true }));
    state.stage = 'configure';
    render();

    for (let i = 0; i < sample.length; i++) {
      try {
        const dry = await dryRunOne(sample[i], picked, raw);
        state.testResult[i].dry = dry;
      } catch (e) {
        state.testResult[i].err = e.message;
      } finally {
        state.testResult[i].loading = false;
        render();
      }
    }
    if (state.testResult.every((r) => !r.err)) state.stage = 'tested';
  }

  function renderTestResult() {
    const blocks = state.testResult.map((r) => {
      if (r.loading) return el('div', { class: 'preview' }, [`Loading ${r.svc.name}…`]);
      if (r.err) return el('div', { class: 'preview', style: { color: '#c00' } },
        [`✗ ${r.svc.name}: ${r.err}`]);
      return el('div', { class: 'preview' }, [
        el('h4', {}, [`✓ ${r.svc.name}  →  POST ${r.dry.url}`]),
        r.dry.bodyPreview,
      ]);
    });
    const okCount = state.testResult.filter((r) => r.dry && !r.err).length;
    return el('div', {}, [
      el('div', { class: 'count' }, [
        el('strong', {}, [`Dry run: ${okCount}/${state.testResult.length} sample items resolved.`]),
        ` Apply enabled if all green.`,
      ]),
      ...blocks,
    ]);
  }

  // ============================================================
  // Apply — sequential or parallel-3 with progress + countdown
  // ============================================================
  async function onApply() {
    const total = state.matched.length;
    const aborted = await countdown(3);
    if (aborted) return;

    state.stage = 'applying';
    state.applyResults = state.matched.map((svc) => ({ svc, status: 'pending' }));
    render();

    const picked = getPickerPayload();
    const raw = getRawPayload();
    const concurrency = state.fast ? 3 : 1;
    let inFlight = 0, idx = 0, done = 0;

    await new Promise((resolve) => {
      const tick = () => {
        if (done >= total) { resolve(); return; }
        while (inFlight < concurrency && idx < total) {
          const i = idx++;
          inFlight++;
          applyOne(state.matched[i], picked, raw)
            .then((r) => {
              state.applyResults[i] = { svc: state.matched[i], ok: r.ok, status: String(r.status), type: r.type };
            })
            .catch((e) => {
              state.applyResults[i] = { svc: state.matched[i], ok: false, status: 'err', error: e.message };
            })
            .finally(() => {
              inFlight--; done++;
              renderApplyProgress(done, total);
              tick();
            });
        }
      };
      tick();
    });

    state.stage = 'done';
    render();
  }

  function countdown(seconds) {
    return new Promise((resolve) => {
      const cd = el('div', { class: 'countdown' }, [
        el('button', { class: 'danger', onclick: () => { abort = true; el2.remove(); resolve(true); } }, ['Abort']),
        el('span', { id: 'cd-text' }, [`Applying to ${state.matched.length} items in ${seconds}…`]),
      ]);
      let abort = false;
      const el2 = cd;
      panel.querySelector('.body').appendChild(cd);
      let n = seconds;
      const t = setInterval(() => {
        n--;
        if (abort) { clearInterval(t); return; }
        const text = cd.querySelector('#cd-text');
        if (n <= 0) {
          clearInterval(t); cd.remove(); resolve(false);
        } else if (text) {
          text.textContent = `Applying to ${state.matched.length} items in ${n}…`;
        }
      }, 1000);
    });
  }

  function renderApplyProgress(done, total) {
    const fill = panel.querySelector('.progress > div');
    if (fill) fill.style.width = `${Math.round((done / total) * 100)}%`;
    const items = panel.querySelector('.results');
    if (!items) return;
    items.innerHTML = '';
    for (const r of state.applyResults) {
      items.appendChild(renderResultRow(r));
    }
  }

  function renderApplyView() {
    const total = state.matched.length;
    const ok = state.applyResults.filter((r) => r.ok).length;
    const fail = state.applyResults.filter((r) => r.status && !r.ok).length;
    const pending = state.applyResults.filter((r) => r.status === 'pending').length;
    return el('div', {}, [
      el('div', { class: 'count' }, [
        el('strong', {}, [state.stage === 'done' ? 'Done.' : 'Applying…']),
        `  ${ok} ✓ / ${fail} ✗ / ${pending} pending`,
      ]),
      el('div', { class: 'progress' }, [
        el('div', { style: { width: `${Math.round(((total - pending) / total) * 100)}%` } }),
      ]),
      el('div', { class: 'results' },
        state.applyResults.map(renderResultRow)),
      state.stage === 'done' ? el('div', { class: 'actions' }, [
        el('div', { class: 'spacer' }),
        el('button', { onclick: downloadReport }, ['Download report']),
        el('button', { class: 'primary', onclick: () => { state.stage = 'configure'; state.applyResults = []; render(); } }, ['Reset']),
      ]) : null,
    ]);
  }

  function renderResultRow(r) {
    const cls = r.status === 'pending' ? '' : (r.ok ? 'ok' : 'fail');
    const icon = r.status === 'pending' ? '·' : (r.ok ? '✓' : '✗');
    const detail = r.error || r.status;
    return el('div', { class: 'item ' + cls }, [
      el('div', { class: 'icon' }, [icon]),
      el('div', { title: r.svc.name }, [r.svc.name]),
      el('div', { style: { color: '#888', fontSize: '11px', textAlign: 'right' } }, [detail]),
    ]);
  }

  function downloadReport() {
    const report = {
      tool: 'pike13-batch v1.1.0',
      subdomain: SUBDOMAIN,
      timestamp: new Date().toISOString(),
      filter: state.filter,
      mode: state.mode,
      pickerSel: state.pickerSel,
      raw: getRawPayload(),
      total: state.applyResults.length,
      ok: state.applyResults.filter((r) => r.ok).length,
      fail: state.applyResults.filter((r) => !r.ok).length,
      results: state.applyResults.map((r) => ({
        id: r.svc.id, name: r.svc.name, type: r.svc.type,
        ok: r.ok, status: r.status, error: r.error,
      })),
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pike13-batch-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ============================================================
  // Drag-to-move on the header
  // ============================================================
  function makeDraggable() {
    const header = panel.querySelector('header');
    if (!header || header.dataset.draggable) return;
    header.dataset.draggable = '1';
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('x')) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = host.getBoundingClientRect();
      ox = r.left; oy = r.top;
      // First drag releases the centering transform so left/top become absolute
      host.style.transform = 'none';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      host.style.left = (ox + e.clientX - sx) + 'px';
      host.style.top  = (oy + e.clientY - sy) + 'px';
      host.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  function close() { host.remove(); }

  // ============================================================
  // Init: fetch catalog and render
  // ============================================================
  panel.appendChild(el('header', {}, [
    el('div', { class: 'title' }, ['pike13-batch']),
    el('div', { class: 'sub' }, [SUBDOMAIN]),
  ]));
  panel.appendChild(el('div', { class: 'body' }, [
    el('div', { class: 'count' }, [`Loading services from ${SUBDOMAIN}.pike13.com…`]),
  ]));

  fetchServices()
    .then((services) => {
      state.services = services;
      state.matched = services;
      render();
    })
    .catch((e) => {
      panel.querySelector('.body').innerHTML = '';
      panel.querySelector('.body').appendChild(
        el('div', { class: 'count', style: { color: '#c00' } },
           [`Failed to load services: ${e.message}`]));
    });
})();
