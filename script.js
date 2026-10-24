/* ==========================================================
   Student Mental Health Score Predictor — front-end logic
   Talks to the FastAPI backend: POST /predict
   ========================================================== */

(() => {
  'use strict';

  /* ---------- Config ---------- */

  const API_BASE = 'http://127.0.0.1:8000';   // no trailing slash
  const REQUEST_TIMEOUT_MS = 20000;

  // Scale used for the gauge. Change if your model's score range is different.
  const SCORE_MAX = 10;

  // Score bands (upper bound is exclusive). Assumes a higher score = better wellbeing.
  const BANDS = [
    { max: 5,        key: 'low',  label: 'Lower end of the scale',  text: 'This profile falls on the lower end of the scale.' },
    { max: 7,        key: 'mid',  label: 'Middle of the scale',     text: 'This profile falls in the middle of the scale.' },
    { max: Infinity, key: 'high', label: 'Higher end of the scale', text: 'This profile falls on the higher end of the scale.' },
  ];

  // Client-side rules, mirroring the Pydantic StudentData model.
  const NUMBER_FIELDS = {
    age:                     { label: 'Age',                  min: 10, max: 100, integer: true },
    avg_daily_usage_hours:   { label: 'Average daily usage',  min: 0,  max: 24 },
    daily_unlocks:           { label: 'Phone unlocks',        min: 0,  integer: true },
    study_hours:             { label: 'Study time',           min: 0,  max: 24 },
    physical_activity_hours: { label: 'Physical activity',    min: 0,  max: 24 },
    sleep_hours_per_night:   { label: 'Sleep per night',      min: 0,  max: 24 },
  };

  const CHOICE_FIELDS = [
    'gender', 'academic_level', 'most_used_platform', 'purpose_of_use', 'stress_level',
  ];

  /* ---------- Elements ---------- */

  const form       = document.getElementById('predict-form');
  const submitBtn  = document.getElementById('submit-btn');
  const btnLabel   = submitBtn.querySelector('.btn-label');
  const resultEl   = document.getElementById('result');
  const views      = resultEl.querySelectorAll('.view');
  const gaugeValue = document.getElementById('gauge-value');
  const scoreEl    = document.getElementById('score');
  const scoreMax   = document.getElementById('score-max');
  const bandLabel  = document.getElementById('band-label');
  const bandText   = document.getElementById('band-text');
  const errTitle   = document.getElementById('error-title');
  const errMessage = document.getElementById('error-message');
  const apiStatus  = document.getElementById('api-status');
  const apiStatusT = document.getElementById('api-status-text');

  const RING_LENGTH = 2 * Math.PI * 54;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  gaugeValue.style.strokeDasharray = RING_LENGTH;
  gaugeValue.style.strokeDashoffset = RING_LENGTH;
  scoreMax.textContent = SCORE_MAX;

  /* ---------- Field error helpers ---------- */

  function fieldWrapper(name) {
    return form.querySelector(`[data-field="${name}"]`);
  }

  function setFieldError(name, message) {
    const wrap = fieldWrapper(name);
    const slot = form.querySelector(`[data-error-for="${name}"]`);
    if (!wrap || !slot) return false;
    slot.textContent = message;
    wrap.classList.add('has-error');
    wrap.querySelectorAll('input, select').forEach(el => el.setAttribute('aria-invalid', 'true'));
    return true;
  }

  function clearFieldError(name) {
    const wrap = fieldWrapper(name);
    const slot = form.querySelector(`[data-error-for="${name}"]`);
    if (!wrap || !slot) return;
    slot.textContent = '';
    wrap.classList.remove('has-error');
    wrap.querySelectorAll('input, select').forEach(el => el.removeAttribute('aria-invalid'));
  }

  function clearAllErrors() {
    form.querySelectorAll('[data-field]').forEach(w => clearFieldError(w.dataset.field));
  }

  function focusFirstError() {
    const first = form.querySelector('.field.has-error');
    if (!first) return;
    const target = first.querySelector('input:not([type="radio"]), select, input[type="radio"]');
    if (target) target.focus();
    first.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  }

  /* ---------- Read + validate ---------- */

  function readForm() {
    const data = new FormData(form);
    const raw = {};
    for (const [key, value] of data.entries()) raw[key] = value;
    return raw;
  }

  function validate(raw) {
    const errors = {};

    // Country (free text)
    if (!raw.country || !raw.country.trim()) {
      errors.country = 'Enter a country.';
    }

    // Choice fields
    for (const name of CHOICE_FIELDS) {
      if (!raw[name]) errors[name] = 'Choose an option.';
    }

    // Numeric fields
    for (const [name, rule] of Object.entries(NUMBER_FIELDS)) {
      const text = (raw[name] ?? '').toString().trim();
      if (text === '') { errors[name] = 'Enter a value.'; continue; }

      const num = Number(text);
      if (!Number.isFinite(num))                  { errors[name] = 'Enter a number.'; continue; }
      if (rule.integer && !Number.isInteger(num)) { errors[name] = 'Use a whole number.'; continue; }
      if (rule.min !== undefined && num < rule.min) {
        errors[name] = rule.max !== undefined
          ? `Enter a value between ${rule.min} and ${rule.max}.`
          : `Enter ${rule.min} or more.`;
        continue;
      }
      if (rule.max !== undefined && num > rule.max) {
        errors[name] = `Enter a value between ${rule.min} and ${rule.max}.`;
      }
    }

    return errors;
  }

  function buildPayload(raw) {
    return {
      age:                     parseInt(raw.age, 10),
      gender:                  raw.gender,
      country:                 raw.country.trim(),
      academic_level:          raw.academic_level,
      most_used_platform:      raw.most_used_platform,
      purpose_of_use:          raw.purpose_of_use,
      avg_daily_usage_hours:   parseFloat(raw.avg_daily_usage_hours),
      daily_unlocks:           parseInt(raw.daily_unlocks, 10),
      study_hours:             parseFloat(raw.study_hours),
      physical_activity_hours: parseFloat(raw.physical_activity_hours),
      sleep_hours_per_night:   parseFloat(raw.sleep_hours_per_night),
      stress_level:            raw.stress_level,
    };
  }

  /* ---------- Result panel states ---------- */

  function showState(state) {
    resultEl.dataset.state = state;
    views.forEach(v => { v.hidden = v.dataset.view !== state; });
  }

  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    submitBtn.classList.toggle('is-loading', isLoading);
    submitBtn.setAttribute('aria-busy', String(isLoading));
    btnLabel.textContent = isLoading ? 'Predicting…' : 'Predict score';
  }

  function showError(title, message) {
    errTitle.textContent = title;
    errMessage.textContent = message;
    showState('error');
    revealResult();
  }

  function revealResult() {
    // On narrow screens the panel sits above the form, so bring it into view.
    if (window.matchMedia('(max-width: 900px)').matches) {
      resultEl.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    }
  }

  function bandFor(score) {
    return BANDS.find(b => score < b.max) || BANDS[BANDS.length - 1];
  }

  function showScore(score) {
    const band = bandFor(score);
    resultEl.dataset.band = band.key;
    bandLabel.textContent = band.label;
    bandText.textContent = band.text;

    showState('success');
    revealResult();

    // Reset ring, then animate to the new value
    gaugeValue.style.transition = 'none';
    gaugeValue.style.strokeDashoffset = RING_LENGTH;
    void gaugeValue.getBoundingClientRect();           // force reflow
    gaugeValue.style.transition = '';

    const ratio = Math.min(Math.max(score / SCORE_MAX, 0), 1);
    gaugeValue.style.strokeDashoffset = RING_LENGTH * (1 - ratio);

    animateNumber(scoreEl, score);
  }

  function animateNumber(el, target) {
    if (reduceMotion) { el.textContent = target.toFixed(2); return; }
    const start = performance.now();
    const duration = 1100;
    const tick = now => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = (target * eased).toFixed(2);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ---------- API status pill ---------- */

  function setApiStatus(status) {
    apiStatus.dataset.status = status;
    apiStatusT.textContent = {
      checking: 'Checking API…',
      online:   'API connected',
      offline:  'API unreachable',
    }[status];
  }

  async function checkApi() {
    setApiStatus('checking');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(`${API_BASE}/`, { signal: ctrl.signal });
      setApiStatus(res.ok ? 'online' : 'offline');
    } catch {
      setApiStatus('offline');
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- API call ---------- */

  async function requestPrediction(payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${API_BASE}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // FastAPI 422: { detail: [ { loc: ['body', 'age'], msg: '...', type: '...' } ] }
  function applyServerValidationErrors(detail) {
    if (!Array.isArray(detail)) return 0;
    let mapped = 0;
    for (const item of detail) {
      const loc = Array.isArray(item.loc) ? item.loc : [];
      const name = loc[loc.length - 1];
      const msg = item.msg ? String(item.msg) : 'Invalid value.';
      if (typeof name === 'string' && setFieldError(name, msg)) mapped++;
    }
    return mapped;
  }

  async function handleErrorResponse(res) {
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }

    if (res.status === 422) {
      const mapped = applyServerValidationErrors(body && body.detail);
      showError(
        'Some values were rejected',
        mapped
          ? 'The server flagged the highlighted fields. Fix them and try again.'
          : 'The server could not accept the submitted data. Check every field and try again.'
      );
      focusFirstError();
      return;
    }

    if (res.status >= 500) {
      showError(
        'The server hit an error',
        `The backend returned ${res.status}. Check the uvicorn terminal for the traceback, then try again.`
      );
      return;
    }

    const detail = body && typeof body.detail === 'string' ? ` ${body.detail}` : '';
    showError('Request failed', `The backend returned ${res.status}.${detail}`);
  }

  /* ---------- Events ---------- */

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearAllErrors();

    const raw = readForm();
    const errors = validate(raw);

    if (Object.keys(errors).length) {
      Object.entries(errors).forEach(([name, msg]) => setFieldError(name, msg));
      focusFirstError();
      return;
    }

    setLoading(true);
    showState('loading');
    revealResult();

    try {
      const res = await requestPrediction(buildPayload(raw));

      if (!res.ok) {
        await handleErrorResponse(res);
        return;
      }

      const data = await res.json();
      const score = Number(data.predicted_mental_health_score);

      if (!Number.isFinite(score)) {
        showError('Unexpected response', 'The server replied, but the response did not include a valid score.');
        return;
      }

      setApiStatus('online');
      showScore(score);

    } catch (err) {
      if (err.name === 'AbortError') {
        showError('The request timed out', 'The server took too long to respond. Check that it is still running and try again.');
      } else {
        setApiStatus('offline');
        showError(
          'Can’t reach the API',
          `No response from ${API_BASE}. Make sure uvicorn is running on port 8000, then try again.`
        );
      }
    } finally {
      setLoading(false);
    }
  });

  // Clear a field's error as soon as the user edits it
  function onFieldEdit(event) {
    const wrap = event.target.closest('[data-field]');
    if (wrap) clearFieldError(wrap.dataset.field);
  }
  form.addEventListener('input', onFieldEdit);
  form.addEventListener('change', onFieldEdit);

  form.addEventListener('reset', () => {
    clearAllErrors();
    showState('idle');
    delete resultEl.dataset.band;
  });

  /* ---------- Init ---------- */

  showState('idle');
  checkApi();
})();