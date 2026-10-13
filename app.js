(function () {
  'use strict';

  var cfg = window.JOB_BOARD_CONFIG;
  var sb = window.supabase.createClient(cfg.url, cfg.key);

  var STATUSES = ['lead', 'tailored', 'applied', 'screening', 'interview', 'offer', 'rejected', 'withdrawn', 'skipped'];
  var ACTIVE = ['tailored', 'screening', 'interview', 'offer'];
  var STATUS_LABEL = { lead: 'Lead', tailored: 'Tailored', applied: 'Applied', screening: 'Screening', interview: 'Interview',
    offer: 'Offer', rejected: 'Rejected', withdrawn: 'Withdrawn', skipped: 'Skipped' };
  var CATEGORY_LABEL = { fde: 'Applied AI / FDE', se: 'Solutions Eng', pm: 'Product', 'ai-eng': 'AI Eng', fellows: 'Fellows', other: 'Other' };
  var COLORS = ['#D4521A', '#1B2A4A', '#2563EB', '#0F766E', '#7C3AED', '#B45309', '#BE185D', '#475569', '#15803D', '#2E6FB8'];
  // Only the columns a card header needs. Description and prep details are fetched when a card is opened.
  var LIST_COLS = 'id,owner,company,title,category,source,link,location,locations,remote,pay_text,status,date_found,date_applied,' +
    'resume_path,referral,fit_score,fit_notes,notes,closed';
  var PAGE = 50;
  var TODAY = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the viewer's timezone

  var state = {
    owner: 'devin', view: 'open', category: 'all', remote: 'all', hideClosed: true,
    summary: [],          // light rows (owner,status,closed,category,remote) used only for counts
    active: [],           // open view: tailored/screening/interview/offer rows (small, not paged)
    items: [],            // current page(s) of the selected view
    total: 0, loading: false, open: {}, detail: {}
  };

  var $ = function (id) { return document.getElementById(id); };
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeUrl(u) { return /^https?:\/\//i.test(u || '') ? u : null; }
  function colorFor(name) {
    var h = 0, s = String(name || '?');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return COLORS[h % COLORS.length];
  }
  function fmtDate(d) {
    if (!d) return '';
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /* ---------- auth ---------- */
  function showLogin(msg, isErr) {
    $('app').hidden = true;
    $('login').hidden = false;
    var m = $('login-msg');
    m.textContent = msg || '';
    m.className = isErr ? 'err' : '';
  }

  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('login-btn');
    btn.disabled = true;
    showLogin('Sending…');
    sb.auth.signInWithOtp({
      email: $('email').value.trim(),
      options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname }
    }).then(function (r) {
      btn.disabled = false;
      if (r.error) showLogin('Could not send the link: ' + r.error.message, true);
      else showLogin('Check your email and click the link to sign in.');
    });
  });

  $('signout').addEventListener('click', function () { sb.auth.signOut(); });

  sb.auth.onAuthStateChange(function (event, session) {
    if (session) start(); else { started = false; showLogin(''); }
  });
  sb.auth.getSession().then(function (r) { if (!r.data.session) showLogin(''); });

  var started = false;
  function start() {
    if (started) return;
    started = true;
    $('login').hidden = true;
    $('app').hidden = false;
    if (location.hash.indexOf('access_token') !== -1 || location.search.indexOf('code=') !== -1) {
      history.replaceState(null, '', location.pathname);
    }
    loadSummary().then(function () { loadView(true); });
  }

  /* ---------- data ---------- */
  function banner(msg) { var b = $('banner'); b.textContent = msg; b.hidden = !msg; }

  // Counts only: a few light columns per row, paged in case the table outgrows one response.
  function loadSummary() {
    var rows = [];
    function page(off) {
      return sb.from('jobs').select('owner,status,closed,category,remote').range(off, off + 999).then(function (r) {
        if (r.error) { banner('Could not load jobs: ' + r.error.message); return; }
        rows = rows.concat(r.data || []);
        if ((r.data || []).length === 1000) return page(off + 1000);
      });
    }
    return page(0).then(function () {
      state.summary = rows;
      renderChrome();
    });
  }
  function mine() { return state.summary.filter(function (j) { return j.owner === state.owner; }); }
  // a lead counts as open unless it is closed and "hide closed" is on; other statuses always count
  function countable(j) { return !(state.hideClosed && j.closed && j.status === 'lead'); }

  function filtered(q) {
    q = q.eq('owner', state.owner);
    if (state.category !== 'all') q = q.eq('category', state.category);
    if (state.remote === 'remote') q = q.eq('remote', true);
    if (state.remote === 'onsite') q = q.or('remote.is.null,remote.eq.false');
    return q;
  }
  function byFit(q) { return q.order('fit_score', { ascending: false, nullsFirst: false }).order('id'); }

  function leadQuery(off) {
    var q = filtered(sb.from('jobs').select(LIST_COLS, { count: 'exact' })).eq('status', 'lead');
    if (state.hideClosed) q = q.eq('closed', false);
    return byFit(q).range(off, off + PAGE - 1);
  }
  function statusQuery(status, off) {
    var q = filtered(sb.from('jobs').select(LIST_COLS, { count: 'exact' })).eq('status', status);
    q = q.order('date_applied', { ascending: false, nullsFirst: false });
    return byFit(q).range(off, off + PAGE - 1);
  }

  var seq = 0;
  function loadView(reset) {
    var mySeq = ++seq;
    state.loading = true;
    if (reset) { state.items = []; state.active = []; state.total = 0; }
    var off = state.items.length;
    var first = state.view === 'open' ? leadQuery(off)
      : (state.view === 'lead' ? leadQuery(off) : statusQuery(state.view, off));
    var act = (reset && state.view === 'open')
      ? filtered(sb.from('jobs').select(LIST_COLS)).in('status', ACTIVE).order('fit_score', { ascending: false, nullsFirst: false })
      : Promise.resolve({ data: null });
    Promise.all([first, act]).then(function (res) {
      if (mySeq !== seq) return; // a newer request superseded this one
      state.loading = false;
      var a = res[0], b = res[1];
      if (a.error || b.error) { banner('Could not load jobs: ' + ((a.error || b.error).message)); return; }
      banner('');
      state.items = state.items.concat(a.data || []);
      state.total = a.count || 0;
      if (b.data) state.active = b.data;
      if (!state.summary.length && !(state.items.length + state.active.length)) {
        banner('No jobs are visible. If this is unexpected, your email may not be on the allow list.');
      }
      render();
    });
  }

  function loadDetail(id) {
    if (state.detail[id]) return Promise.resolve();
    return sb.from('jobs').select('id,description,details').eq('id', id).then(function (r) {
      state.detail[id] = (r.data && r.data[0]) || { description: null, details: null };
    });
  }

  /* ---------- render ---------- */
  function chip(group, value, label, count) {
    var active = state[group] === value ? ' active' : '';
    return '<button class="filter-btn' + active + '" data-group="' + group + '" data-value="' + esc(value) + '">' +
      esc(label) + (count != null ? ' (' + count + ')' : '') + '</button>';
  }

  function viewStatuses() { return state.view === 'open' ? ['lead'].concat(ACTIVE) : [state.view]; }

  function renderChrome() {
    var list = mine().filter(countable);
    var byStatus = {};
    list.forEach(function (j) { byStatus[j.status] = (byStatus[j.status] || 0) + 1; });
    var openCount = (byStatus.lead || 0) + ACTIVE.reduce(function (n, s) { return n + (byStatus[s] || 0); }, 0);
    $('f-status').innerHTML = chip('view', 'open', 'Open', openCount) + STATUSES.filter(function (s) { return byStatus[s]; })
      .map(function (s) { return chip('view', s, STATUS_LABEL[s], byStatus[s]); }).join('');

    var scope = viewStatuses(), byCat = {};
    list.filter(function (j) { return scope.indexOf(j.status) !== -1; }).forEach(function (j) {
      byCat[j.category || 'other'] = (byCat[j.category || 'other'] || 0) + 1;
    });
    $('f-category').innerHTML = chip('category', 'all', 'All', null) + Object.keys(CATEGORY_LABEL).filter(function (c) { return byCat[c]; })
      .map(function (c) { return chip('category', c, CATEGORY_LABEL[c], byCat[c]); }).join('');
    $('f-remote').innerHTML = chip('remote', 'all', 'Any', null) + chip('remote', 'remote', 'Remote', null) + chip('remote', 'onsite', 'On-site / hybrid', null) +
      '<button class="filter-btn' + (state.hideClosed ? ' active' : '') + '" data-toggle-closed="1">Hide closed leads</button>';

    var stat = function (n, l) { return '<div class="nav-stat"><span class="num">' + n + '</span><span class="lbl">' + l + '</span></div>'; };
    var c = function (s) { return byStatus[s] || 0; };
    $('nav-stats').innerHTML = stat(c('lead'), 'Leads') + stat(c('applied'), 'Applied') + stat(c('screening') + c('interview'), 'Active') +
      stat(c('offer'), 'Offers') + stat(c('rejected'), 'Rejected');
  }

  // pipeline rows hold only the score explanation; tracker rows keep their own note after ' || '
  function fitParts(j) {
    var raw = j.fit_notes || '';
    if ((j.source || '').indexOf(':') !== -1) return { why: raw, orig: '' };
    var i = raw.indexOf(' || ');
    return i === -1 ? { why: '', orig: raw } : { why: raw.slice(0, i), orig: raw.slice(i + 4) };
  }
  function fitTier(n) { return n >= 80 ? 'fit-hi' : (n >= 60 ? 'fit-mid' : 'fit-lo'); }
  function listHtml(items) { return '<ul>' + (items || []).map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + '</ul>'; }
  function assessmentHtml(ap) {
    if (!ap || typeof ap !== 'object') return '';
    var h = '<div class="prep-box"><h3 style="margin-bottom:8px;">Assessment Prep</h3>';
    if (ap.disclaimer) h += '<p class="prep-note">' + esc(ap.disclaimer) + '</p>';
    var heads = { whatItIs: 'What it is', strategy: 'Strategy', afterGha: 'What comes after' };
    Object.keys(heads).forEach(function (k) { if (Array.isArray(ap[k])) h += '<h4>' + heads[k] + '</h4>' + listHtml(ap[k]); });
    if (ap.loopReport && Array.isArray(ap.loopReport.items)) {
      h += '<h4>Candidate loop report (anecdotal)</h4>';
      if (ap.loopReport.source) h += '<p class="prep-note">' + esc(ap.loopReport.source) + '</p>';
      h += listHtml(ap.loopReport.items);
    }
    return h + '</div>';
  }

  function cardHtml(j) {
    var open = state.open[j.id] ? ' open' : '';
    var det = state.detail[j.id];
    var d = (det && det.details && typeof det.details === 'object') ? det.details : {};
    var pay = j.pay_text && !/^not disclosed/i.test(j.pay_text) ? '<span class="job-pay">' + esc(j.pay_text) + '</span>' : '<span style="color:#AAA">Pay not disclosed</span>';
    var dateLine = j.date_applied ? 'Applied ' + fmtDate(j.date_applied) : (j.date_found ? 'Found ' + fmtDate(j.date_found) : '');
    var locs = j.locations || [];
    var tags = '';
    if (j.category) tags += '<span class="lead-tag tag-' + esc(j.category) + '">' + esc(CATEGORY_LABEL[j.category] || j.category) + '</span>';
    if (j.remote === true) tags += '<span class="lead-tag tag-remote">Remote</span>';
    else if (j.remote === false) tags += '<span class="lead-tag tag-onsite">On-site / hybrid</span>';
    if (locs.length > 1) tags += '<span class="lead-tag tag-other">' + locs.length + ' locations</span>';
    var fp = fitParts(j);
    var fitN = j.fit_score != null ? Math.round(Number(j.fit_score)) : null;
    var fit = fitN != null ? '<span class="fit-pill ' + fitTier(fitN) + '" data-fit-toggle="1" title="' + esc(fp.why || 'fit score') + '">fit ' + fitN + '</span>' : '';
    var newTag = (j.date_found === TODAY && !j.closed) ? '<span class="new-pill">New today</span>' : '';
    var closedTag = j.closed ? '<span class="closed-tag">Closed</span>' : '';
    var link = safeUrl(j.link);
    var hasPrep = (d.questions && d.questions.length) || (d.talkingPoints && d.talkingPoints.length) || d.assessmentPrep;
    var themes = (d.themes || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('');
    var qa = (d.questions || []).map(function (q, i) {
      return '<div class="qa-item" data-qa="' + esc(j.id) + ':' + i + '"><div class="qa-q"><span>' + esc(q.q) + '</span><span class="qa-hint">Reveal answer</span></div><div class="qa-a">' + esc(q.a) + '</div></div>';
    }).join('');
    var tp = (d.talkingPoints || []).map(function (t) { return '<li><span class="tp-dot"></span><span>' + esc(t) + '</span></li>'; }).join('');
    var statusOpts = STATUSES.map(function (s) {
      return '<option value="' + s + '"' + (s === j.status ? ' selected' : '') + '>' + STATUS_LABEL[s] + '</option>';
    }).join('');
    var desc = det ? esc(det.description || 'No description saved.') : '<span style="color:#999">Loading…</span>';
    var shownLoc = j.location ? esc(j.location.split(' ; ')[0]) : '';

    return '<div class="job-card' + open + '" data-id="' + esc(j.id) + '">' +
      '<div class="job-header" data-toggle="1">' +
        '<div class="co-badge" style="background:' + colorFor(j.company || j.title) + '">' + esc((j.company || j.title || '?').charAt(0)) + '</div>' +
        '<div class="job-info"><div class="job-co">' + esc(j.company || 'Unknown company') + '</div>' +
          '<div class="job-title">' + esc(j.title) + '</div>' +
          '<div class="job-sub">' + (dateLine ? '<span>' + esc(dateLine) + '</span>' : '') + (shownLoc ? '<span>' + shownLoc + (locs.length > 1 ? ' +' + (locs.length - 1) : '') + '</span>' : '') +
            pay + (j.referral ? '<span class="referral-tag">Referral</span>' : '') + newTag + fit + closedTag + '</div>' +
          (fp.why ? '<div class="fit-pop" hidden>' + esc(fp.why) + '</div>' : '') +
          '<div class="lead-tags">' + tags + '</div></div>' +
        '<div class="job-right"><span class="status-badge s-' + esc(j.status) + '">' + esc(STATUS_LABEL[j.status] || j.status) + '</span><span class="chevron">&#8964;</span></div>' +
      '</div>' +
      '<div class="job-body">' +
        '<div class="tab-nav"><button class="tab-btn active" data-tab="overview">Overview</button>' +
          (hasPrep ? '<button class="tab-btn" data-tab="prep">Interview Prep</button>' : '') +
          '<button class="tab-btn" data-tab="notes">Notes</button></div>' +
        '<div class="tab-content">' +
          '<div class="tab-pane active" data-pane="overview">' +
            (j.notes ? '<div class="note-banner">Note: ' + esc(j.notes) + '</div>' : '') +
            '<div class="overview-grid">' +
              '<div class="info-block"><h4>Description</h4><p>' + desc + '</p>' +
                (fp.why ? '<div class="fit-box"><strong>Score:</strong> ' + esc(fp.why) + '</div>' : '') +
                (fp.orig ? '<div class="fit-box">' + esc(fp.orig) + '</div>' : '') + '</div>' +
              '<div class="info-block">' + (themes ? '<h4>Key Themes</h4><div>' + themes + '</div>' : '') +
                (j.referral ? '<p class="meta-line"><strong>Referral:</strong> ' + esc(j.referral) + '</p>' : '') +
                (locs.length ? '<p class="meta-line"><strong>Locations:</strong> ' + esc(locs.join(' · ')) + '</p>' : (j.location ? '<p class="meta-line"><strong>Location:</strong> ' + esc(j.location) + '</p>' : '')) +
                (link ? '<p class="meta-line"><a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">View posting</a></p>' : '') +
                (j.resume_path ? '<p class="meta-line"><strong>Open resume:</strong> <span class="resume-file" title="' + esc(j.resume_path) + '">' + esc(j.resume_path.split('/').pop()) + '</span></p>' : '') +
              '</div>' +
            '</div>' +
            '<div class="status-editor"><label>Update status</label><select data-status-select="' + esc(j.id) + '">' + statusOpts + '</select><span class="save-msg" data-status-msg></span></div>' +
          '</div>' +
          (hasPrep ? '<div class="tab-pane" data-pane="prep">' + assessmentHtml(d.assessmentPrep) +
            (qa ? '<div class="prep-block"><h3>Interview Questions</h3>' + qa + '</div>' : '') +
            (tp ? '<div class="prep-block"><h3>Talking Points</h3><ul class="tp-list">' + tp + '</ul></div>' : '') + '</div>' : '') +
          '<div class="tab-pane" data-pane="notes"><label class="notes-label">Private notes</label>' +
            '<textarea class="notes-ta" data-notes="' + esc(j.id) + '" placeholder="Recruiter name, next steps, things to remember...">' + esc(j.notes || '') + '</textarea>' +
            '<div class="notes-actions"><button class="notes-save" data-save-notes="' + esc(j.id) + '">Save notes</button><span class="save-msg" data-notes-msg></span></div></div>' +
        '</div>' +
      '</div></div>';
  }

  function render() {
    renderChrome();
    var shown = state.active.length + state.items.length;
    var remaining = Math.max(0, state.total - state.items.length);
    $('result-count').textContent = shown + ' shown' + (state.total ? ' of ' + (state.total + state.active.length) : '');
    var html = state.active.map(cardHtml).join('') + state.items.map(cardHtml).join('');
    if (remaining > 0) html += '<button class="more-btn" data-more="1">Load ' + Math.min(PAGE, remaining) + ' more (' + remaining + ' remaining)</button>';
    $('jobs-list').innerHTML = html || '<p class="empty">' + (state.loading ? 'Loading…' : 'Nothing matches these filters.') + '</p>';
  }

  /* ---------- events ---------- */
  function flash(el, msg, isErr) {
    if (!el) return;
    el.textContent = msg;
    el.className = 'save-msg' + (isErr ? ' err' : '');
    if (!isErr) setTimeout(function () { el.textContent = ''; }, 2500);
  }
  function findItem(id) {
    return state.active.concat(state.items).filter(function (j) { return j.id === id; })[0];
  }
  function refreshCard(id) {
    var el = document.querySelector('.job-card[data-id="' + id.replace(/"/g, '') + '"]');
    var j = findItem(id);
    if (el && j) el.outerHTML = cardHtml(j);
  }

  // Persist a change and confirm exactly one row changed (RLS blocks silently).
  function saveField(id, patch, msgEl) {
    flash(msgEl, 'Saving…');
    return sb.from('jobs').update(patch).eq('id', id).select('id,status,notes').then(function (r) {
      if (r.error || !r.data || r.data.length !== 1) {
        flash(msgEl, 'Not saved' + (r.error ? ': ' + r.error.message : ' (no permission)'), true);
        return false;
      }
      var job = findItem(id);
      Object.keys(patch).forEach(function (k) { job[k] = r.data[0][k]; });
      flash(msgEl, 'Saved.');
      return true;
    });
  }

  // after a status change the row may belong to a different bucket or no longer match the view
  function rebucket() {
    var all = state.active.concat(state.items);
    var keepActive = [], keepItems = [];
    all.forEach(function (j) {
      if (state.view === 'open') {
        if (ACTIVE.indexOf(j.status) !== -1) keepActive.push(j);
        else if (j.status === 'lead') keepItems.push(j);
      } else if (j.status === state.view) keepItems.push(j);
    });
    var dropped = all.length - keepActive.length - keepItems.length;
    state.active = keepActive;
    state.items = keepItems;
    state.total = Math.max(0, state.total - dropped);
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    var tab = t.closest('.top-tab-btn');
    if (tab) {
      state.owner = tab.getAttribute('data-owner');
      state.view = 'open'; state.category = 'all'; state.remote = 'all';
      document.querySelectorAll('.top-tab-btn').forEach(function (b) { b.classList.toggle('active', b === tab); });
      renderChrome(); loadView(true);
      return;
    }
    if (t.closest('[data-toggle-closed]')) { state.hideClosed = !state.hideClosed; renderChrome(); loadView(true); return; }
    if (t.closest('[data-more]')) { loadView(false); return; }
    var fpill = t.closest('[data-fit-toggle]');
    if (fpill) {
      var pop = fpill.closest('.job-info').querySelector('.fit-pop');
      if (pop) pop.hidden = !pop.hidden;
      return;
    }
    var f = t.closest('.filter-btn');
    if (f) {
      var g = f.getAttribute('data-group');
      state[g] = f.getAttribute('data-value');
      if (g === 'view') state.category = 'all'; // category options differ per view
      renderChrome(); loadView(true);
      return;
    }

    var card = t.closest('.job-card');
    if (!card) return;
    var id = card.getAttribute('data-id');
    var tb = t.closest('.tab-btn');
    if (tb) {
      card.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.toggle('active', b === tb); });
      card.querySelectorAll('.tab-pane').forEach(function (p) { p.classList.toggle('active', p.getAttribute('data-pane') === tb.getAttribute('data-tab')); });
      return;
    }
    var q = t.closest('.qa-q');
    if (q) {
      var item = q.parentNode, o = item.classList.toggle('open');
      q.querySelector('.qa-hint').textContent = o ? 'Hide' : 'Reveal answer';
      return;
    }
    if (t.closest('[data-save-notes]')) {
      saveField(id, { notes: card.querySelector('[data-notes]').value || null }, card.querySelector('[data-notes-msg]'));
      return;
    }
    if (t.closest('.job-header')) {
      var isOpen = card.classList.toggle('open');
      state.open[id] = isOpen;
      if (isOpen && !state.detail[id]) loadDetail(id).then(function () { refreshCard(id); });
    }
  });

  document.addEventListener('change', function (e) {
    var sel = e.target.closest('[data-status-select]');
    if (!sel) return;
    var card = sel.closest('.job-card'), id = sel.getAttribute('data-status-select');
    var job = findItem(id), prev = job.status;
    saveField(id, { status: sel.value }, card.querySelector('[data-status-msg]')).then(function (ok) {
      if (!ok) { sel.value = prev; return; }
      rebucket();
      loadSummary().then(render);
    });
  });
})();
