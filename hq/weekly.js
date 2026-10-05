/* HQ weekly plan, review notes, and planned throw counts.
   One hq_weekly_plans row per player + Monday (week_of).
   throws_actual is on that row for a later actual throw row; this UI only edits planned. */
(function (root) {
  const DAYS = [
    ['mon', 'Mon'],
    ['tue', 'Tue'],
    ['wed', 'Wed'],
    ['thu', 'Thu'],
    ['fri', 'Fri'],
    ['sat', 'Sat'],
    ['sun', 'Sun'],
  ];
  const WEEK_MEMORY = new Map();

  function parseISODate(iso) {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }

  function toISODate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function addDays(d, n) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  }

  function mondayOf(input) {
    const d = input instanceof Date
      ? new Date(input.getFullYear(), input.getMonth(), input.getDate())
      : parseISODate(input);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return d;
  }

  function formatRange(mondayIso) {
    const start = parseISODate(mondayIso);
    const end = addDays(start, 6);
    const sameYear = start.getFullYear() === end.getFullYear();
    const startText = start.toLocaleDateString('en-US', sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' });
    const endText = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return 'Mon ' + startText + ' – Sun ' + endText;
  }

  function emptyPlan() {
    return {
      availability: '',
      weekly_focus: '',
      bullpen_focus: '',
      plan_vs_rhh: '',
      plan_vs_lhh: '',
      attack_cue: '',
      next_outing_goal: '',
      self_grade: '',
      coach_grade: '',
      what_played: '',
      what_needs_work: '',
      recovery_focus: '',
      coach_notes: '',
      throws_planned: {},
    };
  }

  function asObject(v) {
    if (!v) return {};
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch (e) { return {}; }
    }
    if (typeof v !== 'object' || Array.isArray(v)) return {};
    return v;
  }

  function isMissingRelation(error) {
    if (!error) return false;
    const code = String(error.code || '');
    const msg = String(error.message || '');
    return code === 'PGRST205' || code === '42P01' || /schema cache/i.test(msg) || /does not exist/i.test(msg) || /could not find the table/i.test(msg);
  }

  function paintAvailability(el, value) {
    if (!el) return;
    const v = value || '';
    el.textContent = v || 'Not set';
    el.className = 'chip ' + (v === 'Available' ? 'ok' : v === 'Limited' ? 'limited' : v === 'Unavailable' ? 'out' : 'muted');
    el.setAttribute('aria-label', 'Availability: ' + (v || 'Not set'));
  }

  function shell() {
    const days = DAYS.map(([key, label]) => (
      '<label class="throw-cell" data-day="' + label + '">' +
        '<span class="throw-day">' + label + '</span>' +
        '<input name="planned_' + key + '" type="number" inputmode="numeric" min="0" step="1" aria-label="Planned throws ' + label + '" />' +
      '</label>'
    )).join('');
    return (
      '<form class="week-form" novalidate>' +
        '<div class="week-panels">' +
          '<section class="card">' +
            '<h2>Weekly Plan</h2>' +
            '<div class="week-toolbar">' +
              '<button class="btn secondary" type="button" data-week-nav="-1">Prev</button>' +
              '<label>Week of<input name="week_of" type="date" required /></label>' +
              '<button class="btn secondary" type="button" data-week-nav="1">Next</button>' +
              '<p class="meta week-range"></p>' +
            '</div>' +
            '<div class="week-fields">' +
              '<label>Availability' +
                '<select name="availability">' +
                  '<option value="">—</option>' +
                  '<option value="Available">Available</option>' +
                  '<option value="Limited">Limited</option>' +
                  '<option value="Unavailable">Unavailable</option>' +
                '</select>' +
              '</label>' +
              '<label>Weekly focus<textarea name="weekly_focus" placeholder="Weekly focus"></textarea></label>' +
              '<label>Bullpen focus<textarea name="bullpen_focus" placeholder="Bullpen focus"></textarea></label>' +
              '<label>Plan vs RHH<textarea name="plan_vs_rhh" placeholder="Plan vs right-handed hitters"></textarea></label>' +
              '<label>Plan vs LHH<textarea name="plan_vs_lhh" placeholder="Plan vs left-handed hitters"></textarea></label>' +
              '<label>Attack cue<input name="attack_cue" type="text" placeholder="Attack cue" autocomplete="off" /></label>' +
              '<label>Next outing goal<textarea name="next_outing_goal" placeholder="Next outing goal"></textarea></label>' +
            '</div>' +
          '</section>' +
          '<section class="card">' +
            '<h2>Review Notes</h2>' +
            '<p class="meta" style="margin-bottom:8px">Same player and week as the plan.</p>' +
            '<div class="week-fields">' +
              '<div class="week-grades">' +
                '<label>Self grade (1–10)<input name="self_grade" type="number" inputmode="numeric" min="1" max="10" step="1" placeholder="1–10" /></label>' +
                '<label>Coach grade (1–10)<input name="coach_grade" type="number" inputmode="numeric" min="1" max="10" step="1" placeholder="1–10" /></label>' +
              '</div>' +
              '<label>What played<textarea name="what_played" placeholder="What played"></textarea></label>' +
              '<label>What needs work<textarea name="what_needs_work" placeholder="What needs work"></textarea></label>' +
              '<label>Recovery focus<textarea name="recovery_focus" placeholder="Recovery focus"></textarea></label>' +
              '<label>Coach notes<textarea name="coach_notes" placeholder="Coach notes"></textarea></label>' +
            '</div>' +
          '</section>' +
        '</div>' +
        '<section class="card">' +
          '<h2>Weekly Throw Plan</h2>' +
          '<p class="throw-kicker">Planned</p>' +
          '<div class="throw-grid" data-throw-row="planned">' +
            days +
            '<div class="throw-total-cell">' +
              '<span class="throw-day">Total</span>' +
              '<span class="throw-total" data-throw-total="planned">0</span>' +
            '</div>' +
          '</div>' +
        '</section>' +
        '<div class="week-save">' +
          '<p class="week-note" data-week-status hidden></p>' +
          '<button class="btn" type="submit" data-save>Save week</button>' +
        '</div>' +
      '</form>'
    );
  }

  function sumPlanned(form) {
    let total = 0;
    DAYS.forEach(([key]) => {
      const raw = String(form.elements['planned_' + key].value || '').trim();
      if (raw === '') return;
      const n = Number(raw);
      if (Number.isFinite(n)) total += n;
    });
    return total;
  }

  function readSnapshot(form) {
    const data = {};
    ['availability', 'weekly_focus', 'bullpen_focus', 'plan_vs_rhh', 'plan_vs_lhh', 'attack_cue', 'next_outing_goal', 'self_grade', 'coach_grade', 'what_played', 'what_needs_work', 'recovery_focus', 'coach_notes'].forEach((name) => {
      data[name] = String(form.elements[name].value || '');
    });
    DAYS.forEach(([key]) => {
      data['planned_' + key] = String(form.elements['planned_' + key].value || '');
    });
    return JSON.stringify(data);
  }

  function textOrNull(value) {
    const s = String(value || '').trim();
    return s ? s : null;
  }

  function parseGrade(raw, label) {
    const s = String(raw || '').trim();
    if (!s) return { value: null };
    if (!/^\d+$/.test(s)) return { error: label + ' must be a whole number from 1 to 10, or left blank.' };
    const n = Number(s);
    if (n < 1 || n > 10) return { error: label + ' must be from 1 to 10, or left blank.' };
    return { value: n };
  }

  function parseForm(form) {
    const availability = String(form.elements.availability.value || '');
    if (availability && !['Available', 'Limited', 'Unavailable'].includes(availability)) {
      return { error: 'Availability must be Available, Limited, Unavailable, or blank.' };
    }
    const selfGrade = parseGrade(form.elements.self_grade.value, 'Self grade');
    if (selfGrade.error) return selfGrade;
    const coachGrade = parseGrade(form.elements.coach_grade.value, 'Coach grade');
    if (coachGrade.error) return coachGrade;
    const throwsPlanned = {};
    for (let i = 0; i < DAYS.length; i++) {
      const key = DAYS[i][0];
      const label = DAYS[i][1];
      const raw = String(form.elements['planned_' + key].value || '').trim();
      if (raw === '') continue;
      if (!/^\d+$/.test(raw)) return { error: label + ' throws must be a whole number, or blank.' };
      throwsPlanned[key] = Number(raw);
    }
    return {
      payload: {
        availability: availability || null,
        weekly_focus: textOrNull(form.elements.weekly_focus.value),
        bullpen_focus: textOrNull(form.elements.bullpen_focus.value),
        plan_vs_rhh: textOrNull(form.elements.plan_vs_rhh.value),
        plan_vs_lhh: textOrNull(form.elements.plan_vs_lhh.value),
        attack_cue: textOrNull(form.elements.attack_cue.value),
        next_outing_goal: textOrNull(form.elements.next_outing_goal.value),
        self_grade: selfGrade.value,
        coach_grade: coachGrade.value,
        what_played: textOrNull(form.elements.what_played.value),
        what_needs_work: textOrNull(form.elements.what_needs_work.value),
        recovery_focus: textOrNull(form.elements.recovery_focus.value),
        coach_notes: textOrNull(form.elements.coach_notes.value),
        throws_planned: throwsPlanned,
      },
    };
  }

  function mount(rootEl, opts) {
    if (!rootEl) return;
    const sb = opts.sb;
    const playerId = opts.playerId;
    const availabilityEl = opts.availabilityEl || null;
    rootEl.innerHTML = '<div class="week-wrap">' + shell() + '</div>';
    const form = rootEl.querySelector('form');
    const statusEl = rootEl.querySelector('[data-week-status]');
    const saveBtn = rootEl.querySelector('[data-save]');
    const rangeEl = rootEl.querySelector('.week-range');
    const totalEl = rootEl.querySelector('[data-throw-total="planned"]');
    let currentWeek = WEEK_MEMORY.get(playerId) || toISODate(mondayOf(new Date()));
    let snapshot = '';
    let loadToken = 0;

    function setStatus(text, kind) {
      if (!text) {
        statusEl.hidden = true;
        statusEl.textContent = '';
        statusEl.className = 'week-note';
        return;
      }
      statusEl.hidden = false;
      statusEl.textContent = text;
      statusEl.className = 'week-note' + (kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : '');
    }

    function updateTotal() {
      totalEl.textContent = String(sumPlanned(form));
    }

    function apply(plan) {
      const src = plan || emptyPlan();
      form.elements.availability.value = src.availability || '';
      ['weekly_focus', 'bullpen_focus', 'plan_vs_rhh', 'plan_vs_lhh', 'attack_cue', 'next_outing_goal', 'what_played', 'what_needs_work', 'recovery_focus', 'coach_notes'].forEach((name) => {
        form.elements[name].value = src[name] || '';
      });
      form.elements.self_grade.value = src.self_grade == null || src.self_grade === '' ? '' : String(src.self_grade);
      form.elements.coach_grade.value = src.coach_grade == null || src.coach_grade === '' ? '' : String(src.coach_grade);
      const planned = asObject(src.throws_planned);
      DAYS.forEach(([key]) => {
        const n = planned[key];
        form.elements['planned_' + key].value = n == null || n === '' ? '' : String(n);
      });
      paintAvailability(availabilityEl, form.elements.availability.value);
      updateTotal();
      snapshot = readSnapshot(form);
    }

    function isDirty() {
      return readSnapshot(form) !== snapshot;
    }

    function confirmDiscard() {
      if (!isDirty()) return true;
      return root.confirm('Discard unsaved changes for this week?');
    }

    async function load() {
      const token = ++loadToken;
      const week = currentWeek;
      const snapshotAtStart = snapshot;
      form.elements.week_of.value = week;
      rangeEl.textContent = formatRange(week);
      WEEK_MEMORY.set(playerId, week);
      saveBtn.disabled = true;
      const { data, error } = await sb.from('hq_weekly_plans').select('*').eq('player_id', playerId).eq('week_of', week).maybeSingle();
      if (token !== loadToken) return;
      saveBtn.disabled = false;
      const editedDuringLoad = readSnapshot(form) !== snapshotAtStart;
      if (editedDuringLoad) {
        if (error && isMissingRelation(error)) {
          setStatus('Weekly plans can’t be loaded or saved yet (hq_weekly_plans is not on the database). What you typed stays on the page only. The rest of this page still works.', 'note');
        } else if (error) {
          setStatus(error.message || 'Could not load this week.', 'error');
        }
        paintAvailability(availabilityEl, form.elements.availability.value);
        updateTotal();
        return;
      }
      if (error) {
        apply(emptyPlan());
        if (isMissingRelation(error)) {
          setStatus('Weekly plans can’t be loaded or saved yet (hq_weekly_plans is not on the database). These fields stay blank, and the rest of this page still works.', 'note');
        } else {
          setStatus(error.message || 'Could not load this week.', 'error');
        }
        return;
      }
      apply(data || emptyPlan());
      setStatus(data ? '' : 'Nothing saved for this week.');
    }

    function goTo(nextIso) {
      const monday = toISODate(mondayOf(nextIso));
      if (monday === currentWeek) {
        form.elements.week_of.value = currentWeek;
        return;
      }
      if (!confirmDiscard()) {
        form.elements.week_of.value = currentWeek;
        return;
      }
      currentWeek = monday;
      snapshot = readSnapshot(form);
      setStatus('');
      load();
    }

    form.addEventListener('input', () => {
      setStatus('');
      paintAvailability(availabilityEl, form.elements.availability.value);
      updateTotal();
    });
    form.addEventListener('change', (e) => {
      if (e.target && e.target.name === 'week_of') goTo(e.target.value || currentWeek);
    });
    rootEl.querySelectorAll('[data-week-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const step = Number(btn.getAttribute('data-week-nav'));
        goTo(toISODate(addDays(parseISODate(currentWeek), step * 7)));
      });
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const parsed = parseForm(form);
      if (parsed.error) {
        setStatus(parsed.error, 'error');
        return;
      }
      saveBtn.disabled = true;
      const payload = Object.assign({
        player_id: playerId,
        week_of: currentWeek,
        updated_at: new Date().toISOString(),
      }, parsed.payload);
      const { data, error } = await sb.from('hq_weekly_plans').upsert(payload, { onConflict: 'player_id,week_of' }).select().maybeSingle();
      saveBtn.disabled = false;
      if (error) {
        if (isMissingRelation(error)) {
          setStatus('Not saved. hq_weekly_plans is not on the database yet, so this week stayed on the page only. The rest of this page still works.', 'error');
        } else {
          setStatus(error.message || 'Could not save this week.', 'error');
        }
        return;
      }
      apply(data || payload);
      setStatus('Saved for the week of ' + formatRange(currentWeek) + '.', 'ok');
    });

    apply(emptyPlan());
    form.elements.week_of.value = currentWeek;
    rangeEl.textContent = formatRange(currentWeek);
    paintAvailability(availabilityEl, '');
    load();
  }

  root.WSWeekly = {
    mount: mount,
    mondayOf: mondayOf,
    toISODate: toISODate,
    addDays: addDays,
    parseISODate: parseISODate,
    formatRange: formatRange,
    isMissingRelation: isMissingRelation,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
